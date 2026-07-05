/**
 * Command palette behavior for the analysis page (vanilla, no framework):
 *
 * - `.command` container with `header input` and a `[role="menu"]` of
 *   `[role="menuitem"]` entries; containers marked `data-command-skip` are
 *   input-only dialogs and are left alone.
 * - Typing filters items against their text and `data-keywords`; non-matching
 *   items get `aria-hidden="true"` (CSS hides them, plus group headings and
 *   separators with nothing visible after them).
 * - ArrowUp/Down/Home/End move the `.active` item (mirrored to the input's
 *   `aria-activedescendant`), Enter clicks it, hovering tracks it.
 * - Clicking an item closes the enclosing `dialog.command-dialog` unless the
 *   item has `data-keep-command-open`.
 * - When the dialog (re)opens, the input's text is selected and the filter
 *   re-runs — unlike the old library, items are queried live, so entries
 *   added later (stored tasks/tracks) filter and navigate correctly.
 */

function isSelectable(item: HTMLElement): boolean {
  return (
    !item.hasAttribute('disabled') &&
    item.getAttribute('aria-disabled') !== 'true' &&
    item.getAttribute('aria-hidden') !== 'true' &&
    !item.classList.contains('hidden') &&
    item.style.display !== 'none'
  );
}

function initCommand(container: HTMLElement): void {
  const input = container.querySelector<HTMLInputElement>('header input');
  const menu = container.querySelector<HTMLElement>('[role="menu"]');
  if (!input || !menu) return;

  const allItems = () =>
    Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const visibleItems = () => allItems().filter(isSelectable);

  let activeItem: HTMLElement | null = null;

  const setActive = (item: HTMLElement | null, scroll = false): void => {
    activeItem?.classList.remove('active');
    activeItem = item;
    if (item) {
      item.classList.add('active');
      if (item.id) input.setAttribute('aria-activedescendant', item.id);
      else input.removeAttribute('aria-activedescendant');
      if (scroll) item.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  };

  const applyFilter = (): void => {
    const term = input.value.trim().toLowerCase();
    for (const item of allItems()) {
      // Note: items hidden by the app via the `.hidden` class (e.g.
      // "Download task" without a task loaded) still get marked here so the
      // group auto-hide CSS counts them correctly; the class keeps them
      // invisible regardless of the aria-hidden the filter assigns.
      const text = (item.dataset.filter || item.textContent || '')
        .trim()
        .toLowerCase();
      const keywords = (item.dataset.keywords || '')
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean);
      const matches =
        text.includes(term) || keywords.some((k) => k.includes(term));
      item.setAttribute('aria-hidden', String(!matches));
    }
    setActive(visibleItems()[0] ?? null, true);
  };

  input.addEventListener('input', applyFilter);

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End'].includes(event.key)) {
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      activeItem?.click();
      return;
    }

    const items = visibleItems();
    if (items.length === 0) return;
    event.preventDefault();

    const current = activeItem ? items.indexOf(activeItem) : -1;
    let next = current;
    switch (event.key) {
      case 'ArrowDown':
        if (current < items.length - 1) next = current + 1;
        break;
      case 'ArrowUp':
        next = current > 0 ? current - 1 : 0;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
    }
    if (next !== current) setActive(items[next], true);
  });

  menu.addEventListener('mousemove', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
    if (item && item !== activeItem && isSelectable(item)) setActive(item);
  });

  menu.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="menuitem"]');
    if (item && isSelectable(item)) {
      const dialog = container.closest<HTMLDialogElement>('dialog.command-dialog');
      if (dialog && !item.hasAttribute('data-keep-command-open')) dialog.close();
    }
  });

  // On dialog (re)open: select the input text so typing replaces the previous
  // query, and re-run the filter to pick up dynamically added items.
  const dialog = container.closest<HTMLDialogElement>('dialog.command-dialog');
  if (dialog) {
    new MutationObserver(() => {
      if (dialog.hasAttribute('open')) {
        applyFilter();
        input.select();
      }
    }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  }

  applyFilter();
}

/** Wire every command palette on the page (skips input-only dialogs). */
export function initCommandMenus(root: ParentNode = document): void {
  root
    .querySelectorAll<HTMLElement>('.command:not([data-command-skip])')
    .forEach(initCommand);
}
