import { initNav } from "./nav";
import "./theme"; // auto-apply saved theme
import {
  type GlideCompTheme,
  type ThemeColorKey,
  type ThemeFontRole,
  AVOCADO_THEME,
  BASECOAT_DARK_THEME,
  BASECOAT_LIGHT_THEME,
  applyTheme,
  saveTheme,
  loadSavedTheme,
  resetTheme,
  exportTheme,
  importTheme,
  encodeThemeToURL,
  decodeThemeFromHash,
  preloadFont,
} from "./theme";
import { getAllFonts, LOCAL_FONTS } from "./google-fonts";

// ── State ────────────────────────────────────────────────────────────────────

let theme: GlideCompTheme = structuredClone(
  decodeThemeFromHash() ?? loadSavedTheme() ?? AVOCADO_THEME
);

// Which color swatch is "active" for the image eyedropper
let activeColorKey: ThemeColorKey = "primary";

// All available fonts (local + full Google Fonts directory)
const allFonts: string[] = getAllFonts();

// ── Color Groups (friendly labels) ──────────────────────────────────────────

const COLOR_GROUPS: { label: string; keys: { key: ThemeColorKey; label: string }[] }[] = [
  {
    label: "Page",
    keys: [
      { key: "background", label: "Background" },
      { key: "foreground", label: "Text" },
    ],
  },
  {
    label: "Cards",
    keys: [
      { key: "card", label: "Card" },
      { key: "card-foreground", label: "Card Text" },
      { key: "popover", label: "Popover" },
      { key: "popover-foreground", label: "Popover Text" },
    ],
  },
  {
    label: "Buttons",
    keys: [
      { key: "primary", label: "Primary" },
      { key: "primary-foreground", label: "Primary Text" },
      { key: "secondary", label: "Secondary" },
      { key: "secondary-foreground", label: "Secondary Text" },
    ],
  },
  {
    label: "Accents",
    keys: [
      { key: "muted", label: "Muted" },
      { key: "muted-foreground", label: "Muted Text" },
      { key: "accent", label: "Accent" },
      { key: "accent-foreground", label: "Accent Text" },
    ],
  },
  {
    label: "Details",
    keys: [
      { key: "destructive", label: "Destructive" },
      { key: "border", label: "Border" },
      { key: "input", label: "Input" },
      { key: "ring", label: "Focus Ring" },
    ],
  },
];

const FONT_ROLES: { role: ThemeFontRole; label: string; description: string }[] = [
  { role: "heading", label: "Headings", description: "Page titles, section headers" },
  { role: "body", label: "Body", description: "Paragraphs, table cells" },
  { role: "button", label: "Buttons", description: "Button labels" },
  { role: "caption", label: "Captions", description: "Small text, metadata" },
  { role: "nav", label: "Navigation", description: "Nav links, tab labels" },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === "string") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function updatePreview(): void {
  // Apply to :root so Tailwind/Basecoat classes (btn-primary, bg-background, etc.)
  // update correctly. CSS custom properties resolved at :root (e.g. --color-background:
  // var(--background)) don't re-resolve when overridden on a child div.
  applyTheme(theme);
}

function showToast(msg: string): void {
  const toast = el("div", { className: "fixed bottom-4 right-4 bg-card text-card-foreground px-4 py-2 rounded-lg shadow-lg text-sm z-50 transition-opacity" }, [msg]);
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; }, 2000);
  setTimeout(() => toast.remove(), 2500);
}

// ── Color Swatch Builder ─────────────────────────────────────────────────────

function buildColorSwatch(key: ThemeColorKey, label: string): HTMLElement {
  const wrapper = el("div", { className: "flex flex-col items-center gap-1" });

  const swatch = el("div", {
    className: "w-12 h-12 rounded-lg border-2 border-transparent cursor-pointer hover:border-foreground transition-colors relative",
    title: label,
  });
  swatch.style.backgroundColor = theme.colors[key];

  const input = el("input", { type: "color", className: "absolute inset-0 opacity-0 cursor-pointer w-full h-full" });
  input.value = theme.colors[key];

  input.addEventListener("input", () => {
    theme.colors[key] = input.value;
    swatch.style.backgroundColor = input.value;
    updatePreview();
  });

  swatch.addEventListener("click", () => {
    // Set this as the active swatch for the eyedropper
    activeColorKey = key;
    document.querySelectorAll(".swatch-active-ring").forEach(el => el.classList.remove("swatch-active-ring"));
    swatch.classList.add("swatch-active-ring");
  });

  swatch.appendChild(input);

  const lbl = el("span", { className: "text-[11px] text-muted-foreground text-center leading-tight" }, [label]);
  wrapper.appendChild(swatch);
  wrapper.appendChild(lbl);
  return wrapper;
}

// ── Font Picker (searchable dropdown) ────────────────────────────────────────

function buildFontPicker(role: ThemeFontRole, onChange: () => void): HTMLElement {
  const container = el("div", { className: "relative" });

  const input = el("input", {
    type: "text",
    className: "input w-full text-sm",
    placeholder: "Search fonts...",
  });
  input.value = theme.fonts[role].family;

  const dropdown = el("div", {
    className: "absolute top-full left-0 right-0 mt-1 bg-card border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-30 hidden",
  });

  const localSet = new Set<string>(LOCAL_FONTS);

  function renderOptions(filter: string): void {
    dropdown.innerHTML = "";
    const q = filter.toLowerCase();
    const matches = allFonts.filter(f => f.toLowerCase().includes(q)).slice(0, 30);

    for (const family of matches) {
      const isLocal = localSet.has(family);
      const opt = el("div", {
        className: "px-3 py-2 cursor-pointer hover:bg-accent text-sm flex items-center justify-between",
      });
      const nameSpan = el("span", {}, [family]);
      nameSpan.style.fontFamily = `'${family}', sans-serif`;
      opt.appendChild(nameSpan);
      if (isLocal) {
        opt.appendChild(el("span", { className: "text-[10px] text-muted-foreground ml-2" }, ["local"]));
      }

      opt.addEventListener("mouseenter", () => preloadFont(family));
      opt.addEventListener("click", () => {
        theme.fonts[role].family = family;
        input.value = family;
        dropdown.classList.add("hidden");
        preloadFont(family);
        onChange();
        updatePreview();
      });
      dropdown.appendChild(opt);
    }

    if (matches.length === 0) {
      dropdown.appendChild(el("div", { className: "px-3 py-2 text-sm text-muted-foreground" }, ["No fonts found"]));
    }
  }

  input.addEventListener("focus", () => {
    renderOptions(input.value);
    dropdown.classList.remove("hidden");
  });
  input.addEventListener("input", () => {
    renderOptions(input.value);
    dropdown.classList.remove("hidden");
  });

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target as Node)) {
      dropdown.classList.add("hidden");
    }
  });

  container.appendChild(input);
  container.appendChild(dropdown);
  return container;
}

// ── Font Role Controls ──────────────────────────────────────────────────────

function buildFontRoleControls(roleInfo: { role: ThemeFontRole; label: string; description: string }): HTMLElement {
  const { role, label, description } = roleInfo;
  const section = el("div", { className: "space-y-2 p-3 bg-card/50 rounded-lg" });

  section.appendChild(el("div", { className: "flex items-baseline justify-between" }, [
    el("span", { className: "text-sm font-semibold" }, [label]),
    el("span", { className: "text-[11px] text-muted-foreground" }, [description]),
  ]));

  // Font family picker
  const fontPicker = buildFontPicker(role, () => {});
  section.appendChild(fontPicker);

  // Weight + size row
  const row = el("div", { className: "flex gap-3 items-center" });

  // Weight selector
  const weightLabel = el("label", { className: "text-xs text-muted-foreground" }, ["Weight"]);
  const weightSelect = el("select", { className: "input text-sm py-1 px-2" });
  for (const w of [400, 500, 600, 700]) {
    const opt = el("option", { value: String(w) }, [w === 400 ? "Regular" : w === 500 ? "Medium" : w === 600 ? "Semibold" : "Bold"]);
    if (theme.fonts[role].weight === w) opt.selected = true;
    weightSelect.appendChild(opt);
  }
  weightSelect.addEventListener("change", () => {
    theme.fonts[role].weight = Number(weightSelect.value);
    updatePreview();
  });

  // Size slider
  const sizeLabel = el("label", { className: "text-xs text-muted-foreground" }, ["Size"]);
  const sizeValue = el("span", { className: "text-xs text-muted-foreground tabular-nums w-8" }, [`${theme.fonts[role].size}px`]);
  const sizeSlider = el("input", { type: "range", min: "8", max: "48", step: "1", className: "flex-1 accent-primary" });
  sizeSlider.value = String(theme.fonts[role].size);
  sizeSlider.addEventListener("input", () => {
    theme.fonts[role].size = Number(sizeSlider.value);
    sizeValue.textContent = `${sizeSlider.value}px`;
    updatePreview();
  });

  row.appendChild(el("div", { className: "flex flex-col gap-1" }, [weightLabel, weightSelect]));
  row.appendChild(el("div", { className: "flex flex-col gap-1 flex-1" }, [
    el("div", { className: "flex justify-between" }, [sizeLabel, sizeValue]),
    sizeSlider,
  ]));

  section.appendChild(row);

  // Uppercase toggle (only for button role)
  if (role === "button") {
    const ucRow = el("div", { className: "flex items-center gap-2" });
    const ucCheck = el("input", { type: "checkbox", className: "accent-primary" });
    (ucCheck as HTMLInputElement).checked = theme.fonts.button.uppercase ?? false;
    ucCheck.addEventListener("change", () => {
      theme.fonts.button.uppercase = (ucCheck as HTMLInputElement).checked;
      updatePreview();
    });
    ucRow.appendChild(ucCheck);
    ucRow.appendChild(el("label", { className: "text-xs text-muted-foreground" }, ["Uppercase"]));

    // Letter spacing
    const lsLabel = el("span", { className: "text-xs text-muted-foreground ml-4" }, ["Spacing"]);
    const lsSlider = el("input", { type: "range", min: "0", max: "0.2", step: "0.002", className: "w-20 accent-primary" });
    lsSlider.value = String(parseFloat(theme.fonts.button.letterSpacing ?? "0.014"));
    const lsValue = el("span", { className: "text-xs text-muted-foreground tabular-nums" }, [theme.fonts.button.letterSpacing ?? "0.014em"]);
    lsSlider.addEventListener("input", () => {
      const v = parseFloat((lsSlider as HTMLInputElement).value).toFixed(3);
      theme.fonts.button.letterSpacing = `${v}em`;
      lsValue.textContent = `${v}em`;
      updatePreview();
    });
    ucRow.appendChild(lsLabel);
    ucRow.appendChild(lsSlider);
    ucRow.appendChild(lsValue);
    section.appendChild(ucRow);
  }

  return section;
}

// ── Image Eyedropper ─────────────────────────────────────────────────────────

function buildImageEyedropper(): HTMLElement {
  const section = el("div", { className: "space-y-2" });
  section.appendChild(el("h3", { className: "text-sm font-semibold" }, ["Pick Colors from Image"]));
  section.appendChild(el("p", { className: "text-xs text-muted-foreground" }, [
    "Drop an image below, then click to pick colors. The color goes into the last selected swatch.",
  ]));

  const dropZone = el("div", {
    className: "border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-primary transition-colors min-h-[120px] flex items-center justify-center relative",
  });
  const dropLabel = el("span", { className: "text-sm text-muted-foreground" }, ["Drop image here or click to upload"]);
  dropZone.appendChild(dropLabel);

  const fileInput = el("input", { type: "file", accept: "image/*", className: "hidden" });
  dropZone.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).tagName !== "CANVAS") fileInput.click();
  });

  const canvas = el("canvas", { className: "hidden w-full rounded cursor-crosshair" });
  const loupe = el("div", {
    className: "hidden absolute w-16 h-16 rounded-full border-4 border-white shadow-lg pointer-events-none z-10",
    style: "image-rendering: pixelated;",
  });
  const loupeColor = el("div", { className: "absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] text-foreground bg-card px-2 py-0.5 rounded shadow pointer-events-none" });
  loupe.appendChild(loupeColor);
  dropZone.appendChild(loupe);

  function loadImage(file: File): void {
    const img = new Image();
    img.onload = () => {
      // Size canvas to fit the drop zone width
      const maxW = dropZone.clientWidth - 16;
      const scale = Math.min(1, maxW / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.classList.remove("hidden");
      dropLabel.classList.add("hidden");
    };
    img.src = URL.createObjectURL(file);
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadImage(fileInput.files[0]);
  });

  // Drag & drop
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("border-primary"); });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("border-primary"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("border-primary");
    const file = e.dataTransfer?.files?.[0];
    if (file?.type.startsWith("image/")) loadImage(file);
  });

  // Paste support
  document.addEventListener("paste", (e) => {
    const file = e.clipboardData?.files?.[0];
    if (file?.type.startsWith("image/")) loadImage(file);
  });

  // Eyedropper: hover shows loupe, click picks color
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ctx = canvas.getContext("2d")!;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const hex = `#${pixel[0].toString(16).padStart(2, "0")}${pixel[1].toString(16).padStart(2, "0")}${pixel[2].toString(16).padStart(2, "0")}`;

    loupe.classList.remove("hidden");
    loupe.style.left = `${x - 32}px`;
    loupe.style.top = `${y - 72}px`;
    loupe.style.backgroundColor = hex;
    loupeColor.textContent = hex;
  });

  canvas.addEventListener("mouseleave", () => loupe.classList.add("hidden"));

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ctx = canvas.getContext("2d")!;
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const hex = `#${pixel[0].toString(16).padStart(2, "0")}${pixel[1].toString(16).padStart(2, "0")}${pixel[2].toString(16).padStart(2, "0")}`;

    // Apply to the active swatch
    theme.colors[activeColorKey] = hex;
    updatePreview();

    // Update the swatch UI
    const swatchEl = document.querySelector(`[data-color-key="${activeColorKey}"]`) as HTMLElement | null;
    if (swatchEl) {
      swatchEl.style.backgroundColor = hex;
      const inp = swatchEl.querySelector("input[type=color]") as HTMLInputElement | null;
      if (inp) inp.value = hex;
    }

    showToast(`Picked ${hex} for ${activeColorKey}`);
  });

  dropZone.appendChild(canvas);
  section.appendChild(dropZone);
  section.appendChild(fileInput);
  return section;
}

// ── Shape Controls ──────────────────────────────────────────────────────────

function buildShapeControls(): HTMLElement {
  const section = el("div", { className: "space-y-3" });
  section.appendChild(el("h3", { className: "text-sm font-semibold" }, ["Shapes"]));

  // Card radius
  const cardRow = el("div", { className: "flex items-center gap-3" });
  const cardLabel = el("span", { className: "text-xs text-muted-foreground w-24" }, ["Card radius"]);
  const cardValue = el("span", { className: "text-xs text-muted-foreground tabular-nums w-12" }, [theme.radius]);
  const cardSlider = el("input", { type: "range", min: "0", max: "24", step: "1", className: "flex-1 accent-primary" });
  cardSlider.value = String(parseFloat(theme.radius));
  cardSlider.addEventListener("input", () => {
    theme.radius = `${cardSlider.value}px`;
    if (cardSlider.value === "0") theme.radius = "0";
    cardValue.textContent = theme.radius;
    updatePreview();
  });
  cardRow.appendChild(cardLabel);
  cardRow.appendChild(cardSlider);
  cardRow.appendChild(cardValue);

  // Button radius
  const btnRow = el("div", { className: "flex items-center gap-3" });
  const btnLabel = el("span", { className: "text-xs text-muted-foreground w-24" }, ["Button radius"]);
  const btnValueLabel = el("span", { className: "text-xs text-muted-foreground tabular-nums w-12" });

  // Max 20px = full pill for a ~40px tall button. 9999px stored internally for CSS.
  function btnRadiusLabel(v: number): string {
    if (v >= 20) return "pill";
    return `${v}px`;
  }

  function sliderToRadius(v: number): string {
    return v >= 20 ? "9999px" : `${v}px`;
  }

  function radiusToSlider(r: string): number {
    const px = parseFloat(r);
    return isNaN(px) ? 20 : Math.min(px, 20);
  }

  const btnSlider = el("input", { type: "range", min: "0", max: "20", step: "1", className: "flex-1 accent-primary" });
  btnSlider.value = String(radiusToSlider(theme.buttonRadius));
  btnValueLabel.textContent = btnRadiusLabel(Number(btnSlider.value));

  btnSlider.addEventListener("input", () => {
    const v = Number(btnSlider.value);
    theme.buttonRadius = sliderToRadius(v);
    btnValueLabel.textContent = btnRadiusLabel(v);
    updatePreview();
  });
  btnRow.appendChild(btnLabel);
  btnRow.appendChild(btnSlider);
  btnRow.appendChild(btnValueLabel);

  section.appendChild(cardRow);
  section.appendChild(btnRow);
  return section;
}

// ── Preview Panel ───────────────────────────────────────────────────────────

function buildPreview(): HTMLElement {
  const container = el("div", {
    id: "theme-preview",
    className: "rounded-xl p-6 space-y-5 border border-border",
    style: "background: var(--background); color: var(--foreground);",
  });

  // Card sample
  const card = el("div", {
    className: "rounded-lg p-4 space-y-2",
    style: "background: var(--card); color: var(--card-foreground); border-radius: var(--radius);",
  });
  card.appendChild(el("h2", { className: "font-bold", style: "font-family: var(--font-heading); font-size: var(--font-heading-size); font-weight: var(--font-heading-weight);" }, ["Sample Card"]));
  card.appendChild(el("p", { className: "", style: "font-family: var(--font-body); font-size: var(--font-body-size); font-weight: var(--font-body-weight);" }, [
    "This is body text inside a card. The theme controls how everything looks.",
  ]));
  card.appendChild(el("small", { style: "font-family: var(--font-caption); font-size: var(--font-caption-size); font-weight: var(--font-caption-weight); color: var(--muted-foreground);" }, [
    "Caption text — metadata, timestamps",
  ]));
  container.appendChild(card);

  // Buttons
  const btnRow = el("div", { className: "flex flex-wrap gap-2" });
  for (const [cls, text] of [
    ["btn btn-primary", "Primary"],
    ["btn btn-secondary", "Secondary"],
    ["btn btn-outline", "Outline"],
    ["btn btn-ghost", "Ghost"],
    ["btn btn-destructive", "Destructive"],
  ] as const) {
    btnRow.appendChild(el("button", { className: cls }, [text]));
  }
  container.appendChild(btnRow);

  // Input
  const inputRow = el("div", { className: "space-y-1" });
  inputRow.appendChild(el("label", { className: "text-xs font-medium" }, ["Sample input"]));
  const inp = el("input", {
    type: "text",
    className: "input w-full",
    placeholder: "Type something...",
  });
  inputRow.appendChild(inp);
  container.appendChild(inputRow);

  // Table
  const table = el("table", { className: "w-full text-sm" });
  const thead = el("thead");
  const headRow = el("tr", { className: "border-b border-border" });
  for (const h of ["Pilot", "Distance", "Score"]) {
    headRow.appendChild(el("th", { className: "text-left py-2 px-2 font-semibold" }, [h]));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const [name, dist, score] of [["Alice", "142.3 km", "985"], ["Bob", "138.7 km", "961"], ["Carol", "135.1 km", "943"]]) {
    const row = el("tr", { className: "border-b border-border/50" });
    row.appendChild(el("td", { className: "py-2 px-2" }, [name]));
    row.appendChild(el("td", { className: "py-2 px-2" }, [dist]));
    row.appendChild(el("td", { className: "py-2 px-2" }, [score]));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  // Tabs
  const tabRow = el("div", { className: "flex gap-1" });
  tabRow.appendChild(el("button", { className: "tab-btn tab-btn-active" }, ["Active Tab"]));
  tabRow.appendChild(el("button", { className: "tab-btn" }, ["Inactive"]));
  tabRow.appendChild(el("button", { className: "tab-btn" }, ["Another"]));
  container.appendChild(tabRow);

  // Nav sample
  const navSample = el("div", {
    className: "flex gap-2 items-center p-2 rounded-lg",
    style: "background: var(--background);",
  });
  navSample.appendChild(el("span", {
    className: "text-sm font-semibold",
    style: "font-family: var(--font-nav); font-size: var(--font-nav-size); font-weight: var(--font-nav-weight); color: var(--foreground);",
  }, ["Nav Active"]));
  navSample.appendChild(el("span", {
    className: "text-sm",
    style: "font-family: var(--font-nav); font-size: var(--font-nav-size); color: var(--muted-foreground);",
  }, ["Nav Link"]));
  navSample.appendChild(el("span", {
    className: "text-sm",
    style: "font-family: var(--font-nav); font-size: var(--font-nav-size); color: var(--muted-foreground);",
  }, ["Another"]));
  container.appendChild(navSample);

  return container;
}

// ── Action Buttons ──────────────────────────────────────────────────────────

function buildActions(): HTMLElement {
  const section = el("div", { className: "space-y-2" });

  const row1 = el("div", { className: "flex flex-wrap gap-2" });

  // Apply
  const applyBtn = el("button", { className: "btn btn-primary" }, ["Apply to GlideComp"]);
  applyBtn.addEventListener("click", () => {
    saveTheme(theme);
    applyTheme(theme);
    showToast("Theme saved and applied!");
  });

  // Export
  const exportBtn = el("button", { className: "btn btn-secondary" }, ["Export"]);
  exportBtn.addEventListener("click", () => exportTheme(theme));

  // Import
  const importBtn = el("button", { className: "btn btn-secondary" }, ["Import"]);
  const importInput = el("input", { type: "file", accept: ".json,.glidecomp-theme.json", className: "hidden" });
  importBtn.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    if (!importInput.files?.[0]) return;
    try {
      const imported = await importTheme(importInput.files[0]);
      theme = imported;
      updatePreview();
      rebuildControls();
      showToast(`Loaded theme: ${imported.name}`);
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`);
    }
  });

  // Share Link
  const shareBtn = el("button", { className: "btn btn-secondary" }, ["Share Link"]);
  shareBtn.addEventListener("click", async () => {
    const url = encodeThemeToURL(theme);
    try {
      await navigator.clipboard.writeText(url);
      showToast("Theme link copied to clipboard!");
    } catch {
      // Fallback: select a temporary input
      const tmp = el("input", { type: "text", value: url, className: "sr-only" });
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      tmp.remove();
      showToast("Theme link copied!");
    }
  });

  // Reset to Avo
  const resetAvoBtn = el("button", { className: "btn btn-ghost" }, ["Reset to Avo"]);
  resetAvoBtn.addEventListener("click", () => {
    theme = structuredClone(AVOCADO_THEME);
    resetTheme();
    updatePreview();
    rebuildControls();
    showToast("Theme reset to Avocado");
  });

  // Reset to Basecoat Dark
  const resetBasecoatDarkBtn = el("button", { className: "btn btn-ghost" }, ["Reset to Basecoat Dark"]);
  resetBasecoatDarkBtn.addEventListener("click", () => {
    theme = structuredClone(BASECOAT_DARK_THEME);
    saveTheme(theme);
    applyTheme(theme);
    updatePreview();
    rebuildControls();
    showToast("Theme reset to Basecoat Dark");
  });

  // Reset to Basecoat Light
  const resetBasecoatLightBtn = el("button", { className: "btn btn-ghost" }, ["Reset to Basecoat Light"]);
  resetBasecoatLightBtn.addEventListener("click", () => {
    theme = structuredClone(BASECOAT_LIGHT_THEME);
    saveTheme(theme);
    applyTheme(theme);
    updatePreview();
    rebuildControls();
    showToast("Theme reset to Basecoat Light");
  });

  row1.appendChild(applyBtn);
  row1.appendChild(exportBtn);
  row1.appendChild(importBtn);
  row1.appendChild(shareBtn);
  row1.appendChild(resetAvoBtn);
  row1.appendChild(resetBasecoatDarkBtn);
  row1.appendChild(resetBasecoatLightBtn);
  section.appendChild(row1);
  section.appendChild(importInput);
  return section;
}

// ── Main Layout Builder ─────────────────────────────────────────────────────

function rebuildControls(): void {
  const root = document.getElementById("theme-editor-root")!;
  root.innerHTML = "";

  const layout = el("div", { className: "flex flex-col lg:flex-row gap-6" });

  // ── Left: Controls ──
  const controls = el("div", { className: "flex-1 space-y-6 min-w-0" });

  // Theme name + author
  const metaRow = el("div", { className: "grid grid-cols-2 gap-3" });
  const nameInput = el("input", { type: "text", className: "input w-full text-sm", placeholder: "Theme name" });
  nameInput.value = theme.name;
  nameInput.addEventListener("input", () => { theme.name = nameInput.value; });
  const authorInput = el("input", { type: "text", className: "input w-full text-sm", placeholder: "Author" });
  authorInput.value = theme.author;
  authorInput.addEventListener("input", () => { theme.author = authorInput.value; });
  metaRow.appendChild(el("div", { className: "space-y-1" }, [el("label", { className: "text-xs font-medium" }, ["Theme Name"]), nameInput]));
  metaRow.appendChild(el("div", { className: "space-y-1" }, [el("label", { className: "text-xs font-medium" }, ["Author"]), authorInput]));
  controls.appendChild(metaRow);

  // Colors
  const colorsSection = el("div", { className: "space-y-3" });
  colorsSection.appendChild(el("h3", { className: "text-sm font-semibold" }, ["Colors"]));
  for (const group of COLOR_GROUPS) {
    const groupEl = el("div", { className: "space-y-1" });
    groupEl.appendChild(el("span", { className: "text-xs text-muted-foreground font-medium" }, [group.label]));
    const swatchRow = el("div", { className: "flex flex-wrap gap-2" });
    for (const { key, label } of group.keys) {
      const swatch = buildColorSwatch(key, label);
      // Add data attribute for eyedropper update
      const swatchDiv = swatch.querySelector("div")!;
      swatchDiv.setAttribute("data-color-key", key);
      swatchRow.appendChild(swatch);
    }
    groupEl.appendChild(swatchRow);
    colorsSection.appendChild(groupEl);
  }
  controls.appendChild(colorsSection);

  // Image eyedropper
  controls.appendChild(buildImageEyedropper());

  // Typography
  const typoSection = el("div", { className: "space-y-3" });
  typoSection.appendChild(el("h3", { className: "text-sm font-semibold" }, ["Typography"]));
  for (const roleInfo of FONT_ROLES) {
    typoSection.appendChild(buildFontRoleControls(roleInfo));
  }
  controls.appendChild(typoSection);

  // Shapes
  controls.appendChild(buildShapeControls());

  // Actions
  controls.appendChild(buildActions());

  layout.appendChild(controls);

  // ── Right: Preview ──
  const previewWrapper = el("div", { className: "lg:w-[400px] lg:sticky lg:top-20 lg:self-start" });
  previewWrapper.appendChild(el("h3", { className: "text-sm font-semibold mb-2" }, ["Preview"]));
  previewWrapper.appendChild(buildPreview());
  layout.appendChild(previewWrapper);

  root.appendChild(layout);

  // Apply current theme to :root so the entire page (including preview) reflects it
  updatePreview();
}

// ── Active swatch ring style ────────────────────────────────────────────────

function injectEditorStyles(): void {
  const style = document.createElement("style");
  style.textContent = `
    .swatch-active-ring {
      outline: 3px solid var(--primary) !important;
      outline-offset: 2px;
    }
  `;
  document.head.appendChild(style);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await initNav();
  injectEditorStyles();
  rebuildControls();
}

init();
