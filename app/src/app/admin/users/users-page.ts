import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ManagedUser, UserAdminError, UserAdminService } from '../../core/aws/user-admin.service';
import { MediaDbService } from '../../core/db/media-db.service';
import { MediaDirectory } from '../../core/db/schema';
import { I18nService, TranslatePipe } from '../../core/i18n/i18n.service';
import { MessageKey } from '../../core/i18n/messages.en';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Icon } from '../../ui/icon';

interface UserForm {
  /** Set when editing an existing account. */
  username?: string;
  email: string;
  name: string;
  role: 'viewer' | 'uploader';
  canDownload: boolean;
  categories: Set<string>;
}

const TINTS = ['#5EE6F0', '#FF7AB6', '#F5C96B', '#5FE0A8', '#9F8CFF', '#FF9A7A'];

/** Admin › Users: invite viewers/uploaders, choose which sections they
 * see, disable or delete them. (Admins are managed outside the app.) */
@Component({
  selector: 'app-users-page',
  standalone: true,
  imports: [FormsModule, Icon, ConfirmDialog, TranslatePipe],
  templateUrl: './users-page.html',
})
export class UsersPage {
  protected readonly service = inject(UserAdminService);
  private readonly mediaDb = inject(MediaDbService);
  private readonly i18n = inject(I18nService);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly confirmDelete = viewChild.required<ConfirmDialog>('confirmDelete');

  protected readonly roles = ['viewer', 'uploader'] as const;
  protected readonly users = signal<ManagedUser[] | null>(null);
  protected readonly loadError = signal(false);
  protected readonly form = signal<UserForm | null>(null);
  protected readonly editing = computed(() => {
    const username = this.form()?.username;
    return username ? (this.users()?.find((u) => u.username === username) ?? null) : null;
  });
  protected readonly saving = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);

  protected readonly sections = computed<MediaDirectory[]>(() => {
    this.mediaDb.version();
    return this.mediaDb.ready() ? this.mediaDb.listDirectories() : [];
  });
  private readonly sectionByKey = computed(() => new Map(this.sections().map((d) => [d.categoryKey, d.displayName])));

  constructor() {
    if (this.service.available) {
      void this.load();
    }
  }

  protected async load(): Promise<void> {
    this.loadError.set(false);
    try {
      this.users.set(await this.service.list());
    } catch {
      this.loadError.set(true);
    }
  }

  // ---- Display ---------------------------------------------------------

  protected displayName(user: ManagedUser): string {
    return user.name || user.email.split('@')[0];
  }

  protected initials(user: ManagedUser): string {
    const words = this.displayName(user).split(/[\s._-]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : this.displayName(user).slice(0, 2)).toUpperCase();
  }

  protected tint(user: ManagedUser): string {
    let hash = 0;
    for (const ch of user.email) {
      hash = (hash * 31 + ch.charCodeAt(0)) | 0;
    }
    return user.enabled ? TINTS[Math.abs(hash) % TINTS.length] : '#A9A3C4';
  }

  protected roleLabel(user: ManagedUser): string {
    const role = this.i18n.t(`users.role.${user.role}` as MessageKey);
    return user.canDownload && user.role !== 'admin' ? `${role} · ${this.i18n.t('users.downloads')}` : role;
  }

  protected roleOption(role: 'viewer' | 'uploader'): string {
    return this.i18n.t(`users.roleOption.${role}` as MessageKey);
  }

  protected roleHelp(role: 'viewer' | 'uploader'): string {
    return this.i18n.t(`users.roleHelp.${role}` as MessageKey);
  }

  protected sectionsLabel(user: ManagedUser): string {
    if (user.role === 'admin') {
      return this.i18n.t('users.allSections');
    }
    const names = user.categories.map((c) => this.sectionByKey().get(c) ?? c);
    return names.length ? names.join(' · ') : this.i18n.t('users.noSections');
  }

  protected status(user: ManagedUser): 'disabled' | 'invited' | 'active' {
    if (!user.enabled) {
      return 'disabled';
    }
    return user.status === 'FORCE_CHANGE_PASSWORD' ? 'invited' : 'active';
  }

  protected statusLabel(user: ManagedUser): string {
    return this.i18n.t(`users.status.${this.status(user)}` as MessageKey);
  }

  protected since(user: ManagedUser): string {
    return user.createdAt
      ? this.i18n.t('users.since', { date: new Date(user.createdAt).toLocaleDateString(this.i18n.locale(), { day: 'numeric', month: 'long', year: 'numeric' }) })
      : '';
  }

  // ---- Panel -------------------------------------------------------------

  protected openInvite(): void {
    // New people see every section by default; untick what they shouldn't.
    this.openForm({ email: '', name: '', role: 'viewer', canDownload: false, categories: new Set(this.sections().map((s) => s.categoryKey)) });
  }

  protected openEdit(user: ManagedUser): void {
    if (user.role === 'admin') {
      return;
    }
    this.openForm({
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      canDownload: user.canDownload,
      categories: new Set(user.categories),
    });
  }

  private openForm(form: UserForm): void {
    this.form.set(form);
    this.error.set(null);
    this.notice.set(null);
    setTimeout(() => {
      const el = this.panel()?.nativeElement;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  }

  protected close(): void {
    this.form.set(null);
  }

  protected update(patch: Partial<UserForm>): void {
    this.form.update((f) => (f ? { ...f, ...patch } : f));
  }

  protected toggleSection(key: string, on: boolean): void {
    this.form.update((f) => {
      if (!f) {
        return f;
      }
      const categories = new Set(f.categories);
      if (on) {
        categories.add(key);
      } else {
        categories.delete(key);
      }
      return { ...f, categories };
    });
  }

  protected async save(): Promise<void> {
    const form = this.form();
    if (!form) {
      return;
    }
    this.error.set(null);
    this.saving.set(true);
    const input = { name: form.name.trim(), role: form.role, canDownload: form.canDownload, categories: [...form.categories] };
    try {
      if (form.username) {
        await this.service.update({ username: form.username, ...input });
        this.notice.set(this.i18n.t('users.saved'));
      } else {
        await this.service.invite({ email: form.email.trim(), ...input });
        this.notice.set(this.i18n.t('users.invited', { email: form.email.trim() }));
      }
      this.form.set(null);
      await this.load();
    } catch (err) {
      this.error.set(this.message(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected async setEnabled(user: ManagedUser, enabled: boolean): Promise<void> {
    await this.run(() => this.service.setEnabled(user.username, enabled), enabled ? 'users.enabledDone' : 'users.disabledDone');
  }

  protected async resend(user: ManagedUser): Promise<void> {
    await this.run(() => this.service.resendInvite(user.username), 'users.resent');
  }

  protected async remove(user: ManagedUser): Promise<void> {
    if (!(await this.confirmDelete().ask())) {
      return;
    }
    await this.run(() => this.service.remove(user.username), 'users.deleted');
    this.form.set(null);
  }

  private async run(action: () => Promise<void>, done: MessageKey): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      this.notice.set(this.i18n.t(done));
      await this.load();
    } catch (err) {
      this.error.set(this.message(err));
    } finally {
      this.busy.set(false);
    }
  }

  private message(err: unknown): string {
    const code = err instanceof UserAdminError ? err.code : 'failed';
    return this.i18n.t(`users.error.${code}` as MessageKey);
  }
}
