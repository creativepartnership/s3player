import { ChangeDetectionStrategy, Component, ElementRef, input, viewChild } from '@angular/core';
import { TranslatePipe } from '../core/i18n/i18n.service';
import { Icon } from './icon';

/** A themed confirmation dialog (instead of the browser's grey confirm()).
 * `await dialog.ask()` resolves true on confirm, false on cancel/Escape.
 * The explanation goes in as content. */
@Component({
  selector: 's3-confirm',
  standalone: true,
  imports: [Icon, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="s3-dialog" [attr.aria-labelledby]="'confirm-title'" (close)="settle(dialog.returnValue === 'confirm')" (click)="onBackdrop($event)">
      <form method="dialog" class="flex flex-col gap-[18px]">
        <h2 id="confirm-title" class="font-display text-2xl leading-tight font-bold">{{ heading() }}</h2>
        <div class="flex flex-col gap-3 text-[15px] leading-relaxed">
          <ng-content />
        </div>
        <div class="flex flex-wrap justify-end gap-2.5">
          <button type="submit" value="cancel" class="s3-btn s3-btn-quiet h-[50px]! px-5! text-[15px]!">{{ 'action.cancel' | t }}</button>
          <button type="submit" value="confirm" class="s3-btn h-[50px]! px-5! text-[15px]!" [class.s3-btn-danger]="danger()" [class.s3-btn-primary]="!danger()">
            @if (danger()) {
              <s3-icon name="trash" [size]="18" [stroke]="2.2" />
            }
            {{ confirmLabel() }}
          </button>
        </div>
      </form>
    </dialog>
  `,
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly confirmLabel = input.required<string>();
  readonly danger = input(false);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private resolve: ((ok: boolean) => void) | null = null;

  ask(): Promise<boolean> {
    const el = this.dialog().nativeElement;
    el.returnValue = '';
    el.showModal();
    // The safe choice has focus first.
    queueMicrotask(() => el.querySelector<HTMLButtonElement>('button[value="cancel"]')?.focus());
    return new Promise((resolve) => (this.resolve = resolve));
  }

  protected settle(ok: boolean): void {
    this.resolve?.(ok);
    this.resolve = null;
  }

  /** A click on the backdrop (the dialog element itself, outside the form) cancels. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) {
      this.dialog().nativeElement.close('cancel');
    }
  }
}
