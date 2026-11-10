"""Makes uploaded videos playable in every browser.

Browsers play MP4 with H.264/HEVC/AV1 video and AAC/MP3/Opus audio. Many
files people have are MKV (Safari won't open those) and/or have AC3/DTS
audio (Chrome and Firefox play those silently). For each video key it is
given, this function:

* probes the file (ffprobe over a presigned URL: only the headers are read);
* if needed, remuxes it to <same name>.mp4: the video stream is copied as is
  (no re-encoding, no quality loss, fast), a stereo AAC track is added as the
  default audio, and the original audio tracks are kept after it, so nothing
  is lost; then replaces the original with it;
* extracts text subtitles embedded in the file to <name>.<lang>.vtt sidecar
  files, which the catalog-sync function attaches to the item;
* extracts every other audio language to a stereo AAC <name>.<lang>.m4a
  sidecar. Browsers can't switch between the audio tracks inside one file
  (only Safari has an API for it), so the player plays these in sync with the
  muted video instead. Each sidecar carries the main track's language in its
  S3 metadata (s3player-main-language), for the player's language menu.

Video in other codecs (MPEG-4 Part 2/XviD, VC-1, …) would need re-encoding,
which takes far longer than a Lambda can run: those are left alone.

Every processed object gets the tag s3player-playback=<result>, so the same
file is never probed twice, and s3player-audio=<version> once its audio
languages have been extracted: a video processed before that existed only
gets the audio pass (on the next resync). Tagging doesn't fire ObjectCreated
events, so it doesn't wake the catalog-sync function either.

Input: an SQS event whose message bodies are {"keys": [...]}, or a direct
invocation with {"keys": [...]} (e.g. from the CLI).
"""

import json
import logging
import os
import shutil
import subprocess
import time

import boto3
from boto3.s3.transfer import TransferConfig

log = logging.getLogger()
log.setLevel(logging.INFO)

s3 = boto3.client("s3")
BUCKET = os.environ["MEDIA_BUCKET_NAME"]
TMP = "/tmp/transcode"
TAG = "s3player-playback"
AUDIO_TAG = "s3player-audio"
AUDIO_VERSION = "1"
MAIN_LANGUAGE_METADATA = "s3player-main-language"

# Output must fit in /tmp next to nothing else; leave some headroom.
MAX_INPUT_BYTES = int(os.environ.get("MAX_INPUT_BYTES", str(9 * 1024**3)))
# Stop ffmpeg this long before the Lambda timeout (time to clean up and tag).
SAFETY_MARGIN_S = 60

WEB_VIDEO = {"h264", "hevc", "av1", "vp9"}
WEB_AUDIO = {"aac", "mp3", "opus", "flac"}
# Audio codecs the MP4 container can carry as-is (kept as extra tracks).
MP4_AUDIO = WEB_AUDIO | {"ac3", "eac3", "alac", "dts"}
TEXT_SUBTITLES = {"subrip", "ass", "ssa", "mov_text", "webvtt", "text"}
MP4_EXTENSIONS = (".mp4", ".m4v", ".mov")


def handler(event, context):
    keys = []
    for record in event.get("Records", []):
        try:
            keys += json.loads(record["body"]).get("keys", [])
        except (KeyError, ValueError):
            continue
    keys += event.get("keys", [])
    results = {}
    for key in dict.fromkeys(keys):
        try:
            results[key] = process(key, context)
        except Exception:  # noqa: BLE001 - one bad file mustn't block the others
            log.exception("Failed on %s", key)
            # Not tagged: a later resync tries it again.
            results[key] = "error"
        finally:
            shutil.rmtree(TMP, ignore_errors=True)
    log.info(json.dumps(results))
    return results


def process(key, context):
    try:
        tags = {t["Key"]: t["Value"] for t in s3.get_object_tagging(Bucket=BUCKET, Key=key)["TagSet"]}
    except s3.exceptions.NoSuchKey:
        return "gone"
    if TAG in tags and tags.get(AUDIO_TAG) == AUDIO_VERSION:
        return "already-done"

    size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
    url = s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=3600)
    info = probe(url)
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    subtitles = [s for s in streams if s.get("codec_type") == "subtitle" and s.get("codec_name") in TEXT_SUBTITLES]
    main = main_audio(audios)

    stem, ext = os.path.splitext(key)
    os.makedirs(TMP, exist_ok=True)

    if TAG in tags:
        # Processed before audio extraction existed: just add the languages.
        # (Not for an original left next to its .mp4 twin: the sidecars,
        # named after the stem, would attach to that other file.)
        if video is not None and video.get("codec_name") in WEB_VIDEO and tags[TAG] != "target-exists":
            audio_outputs = plan_audio(stem, audios, main)
            if audio_outputs:
                run_ffmpeg(url, audio_args(audio_outputs), context)
                upload_audio(audio_outputs, main)
        set_tag(key, tags[TAG])
        return "audio-added"

    if video is None:
        return set_tag(key, "no-video")

    sub_outputs = plan_subtitles(stem, subtitles)

    vcodec = video.get("codec_name")
    in_mp4 = ext.lower() in MP4_EXTENSIONS
    audio_ok = main is None or main.get("codec_name") in WEB_AUDIO
    needs_remux = vcodec in WEB_VIDEO and not (in_mp4 and audio_ok)

    if vcodec not in WEB_VIDEO:
        log.warning("%s: video codec %s would need re-encoding; leaving it as is", key, vcodec)
        if sub_outputs:
            run_ffmpeg(url, subtitle_args(sub_outputs), context)
            upload_subtitles(sub_outputs)
        return set_tag(key, f"unsupported-{vcodec}")

    audio_outputs = plan_audio(stem, audios, main)

    if not needs_remux or size > MAX_INPUT_BYTES:
        if needs_remux:
            log.warning("%s: %d bytes is too large to convert in Lambda", key, size)
        if sub_outputs or audio_outputs:
            run_ffmpeg(url, subtitle_args(sub_outputs) + audio_args(audio_outputs), context)
            upload_subtitles(sub_outputs)
            upload_audio(audio_outputs, main)
        return set_tag(key, "too-large" if needs_remux else "ok")

    target = stem + ".mp4"
    if target != key and exists(target):
        log.warning("%s: %s already exists; not overwriting it", key, target)
        return set_tag(key, "target-exists")

    out = os.path.join(TMP, "out.mp4")
    args = remux_args(video, audios, main, out) + subtitle_args(sub_outputs) + audio_args(audio_outputs)
    run_ffmpeg(url, args, context)

    upload_subtitles(sub_outputs)
    upload_audio(audio_outputs, main)
    s3.upload_file(
        out,
        BUCKET,
        target,
        ExtraArgs={"ContentType": "video/mp4", "Tagging": f"{TAG}=converted&{AUDIO_TAG}={AUDIO_VERSION}"},
        Config=TransferConfig(multipart_chunksize=64 * 1024**2, max_concurrency=8),
    )
    if target != key:
        # The catalog-sync function sees the new .mp4 arrive and the original
        # go, and swaps the catalog item over (same name, so same artwork and
        # subtitles).
        s3.delete_object(Bucket=BUCKET, Key=key)
    log.info("%s -> %s (%s/%s)", key, target, vcodec, main.get("codec_name") if main else "no audio")
    return "converted"


def probe(url):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", url],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return json.loads(result.stdout)


def main_audio(audios):
    """The track browsers play by default: the first one (a remuxed file gets
    it as its only default track; for files left as they are, the first track
    is what browsers pick, whatever the default flags say)."""
    return audios[0] if audios else None


def remux_args(video, audios, main, out):
    args = ["-map", f"0:{video['index']}", "-c:v", "copy"]
    if video.get("codec_name") == "hevc":
        args += ["-tag:v", "hvc1"]  # what Safari/Chrome expect for HEVC in MP4
    n = 0
    if main is not None:
        if main.get("codec_name") in WEB_AUDIO:
            args += ["-map", f"0:{main['index']}", f"-c:a:{n}", "copy"]
        else:
            args += ["-map", f"0:{main['index']}", f"-c:a:{n}", "aac", f"-ac:a:{n}", "2", f"-b:a:{n}", "192k"]
        args += language_args(main, n)
        args += [f"-disposition:a:{n}", "default"]
        n += 1
        # Keep the original tracks too (the untouched surround track, other
        # languages), after the playable one.
        for audio in audios:
            if audio is main and main.get("codec_name") in WEB_AUDIO:
                continue
            if audio.get("codec_name") not in MP4_AUDIO:
                log.info("Dropping audio track %s (%s): MP4 can't carry it", audio["index"], audio.get("codec_name"))
                continue
            args += ["-map", f"0:{audio['index']}", f"-c:a:{n}", "copy", f"-disposition:a:{n}", "0"]
            args += language_args(audio, n)
            n += 1
    args += ["-map_chapters", "0", "-strict", "experimental", "-movflags", "+faststart", "-f", "mp4", out]
    return args


def language_args(stream, n):
    lang = (stream.get("tags") or {}).get("language")
    return [f"-metadata:s:a:{n}", f"language={lang}"] if lang else []


def language_of(stream):
    lang = ((stream.get("tags") or {}).get("language") or "und").strip().lower()
    return lang if lang.isalpha() and 2 <= len(lang) <= 3 else "und"


def plan_audio(stem, audios, main):
    """One <stem>.<lang>.m4a per audio language other than the main track's
    (the first track of each language; "und" tracks get <stem>.audio<N>.m4a),
    unless that file already exists."""
    if main is None:
        return []
    seen = {language_of(main)}
    outputs = []
    for n, audio in enumerate(audios, start=1):
        if audio is main:
            continue
        lang = language_of(audio)
        if lang != "und" and lang in seen:
            continue
        seen.add(lang)
        key = f"{stem}.{lang}.m4a" if lang != "und" else f"{stem}.audio{n}.m4a"
        if exists(key):
            continue
        outputs.append({"index": audio["index"], "key": key, "path": os.path.join(TMP, f"audio{audio['index']}.m4a")})
    return outputs


def audio_args(outputs):
    args = []
    for o in outputs:
        args += ["-map", f"0:{o['index']}", "-vn", "-sn", "-dn", "-c:a", "aac", "-ac", "2", "-b:a", "160k",
                 "-movflags", "+faststart", "-f", "mp4", o["path"]]
    return args


def upload_audio(outputs, main):
    main_lang = language_of(main) if main is not None else "und"
    for o in outputs:
        if os.path.exists(o["path"]) and os.path.getsize(o["path"]) > 0:
            s3.upload_file(
                o["path"],
                BUCKET,
                o["key"],
                ExtraArgs={"ContentType": "audio/mp4", "Metadata": {MAIN_LANGUAGE_METADATA: main_lang}},
                Config=TransferConfig(multipart_chunksize=64 * 1024**2, max_concurrency=8),
            )


def plan_subtitles(stem, subtitles):
    """One <stem>.<lang>[.forced].vtt per embedded text subtitle track, unless
    that file already exists (uploaded by hand, or extracted before)."""
    outputs = []
    used = set()
    for sub in subtitles:
        tags = sub.get("tags") or {}
        lang = (tags.get("language") or "und").lower()
        name = f"{stem}.{lang}" if lang != "und" else stem
        if sub.get("disposition", {}).get("forced"):
            name += ".forced"
        if name in used:
            name += f".{sub['index']}"
        used.add(name)
        key = name + ".vtt"
        if exists(key):
            continue
        outputs.append({"index": sub["index"], "key": key, "path": os.path.join(TMP, f"sub{sub['index']}.vtt")})
    return outputs


def subtitle_args(outputs):
    args = []
    for o in outputs:
        args += ["-map", f"0:{o['index']}", "-c:s", "webvtt", "-f", "webvtt", o["path"]]
    return args


def upload_subtitles(outputs):
    for o in outputs:
        if os.path.exists(o["path"]) and os.path.getsize(o["path"]) > 0:
            s3.upload_file(o["path"], BUCKET, o["key"], ExtraArgs={"ContentType": "text/vtt; charset=utf-8"})


def run_ffmpeg(url, output_args, context):
    timeout = context.get_remaining_time_in_millis() / 1000 - SAFETY_MARGIN_S if context else None
    if timeout is not None and timeout < 30:
        raise TimeoutError("Not enough time left to run ffmpeg")
    started = time.time()
    subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
         "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
         "-i", url, *output_args],
        check=True,
        timeout=timeout,
    )
    log.info("ffmpeg took %.0f s", time.time() - started)


def exists(key):
    try:
        s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except s3.exceptions.ClientError:
        return False


def set_tag(key, value):
    try:
        s3.put_object_tagging(
            Bucket=BUCKET,
            Key=key,
            Tagging={"TagSet": [{"Key": TAG, "Value": value}, {"Key": AUDIO_TAG, "Value": AUDIO_VERSION}]},
        )
    except s3.exceptions.ClientError:
        log.warning("Could not tag %s", key)
    return value
