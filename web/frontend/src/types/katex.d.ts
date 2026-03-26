declare module 'katex/dist/contrib/auto-render.mjs' {
  export default function renderMathInElement(
    element: HTMLElement,
    options?: {
      delimiters?: Array<{ left: string; right: string; display: boolean }>;
      throwOnError?: boolean;
      errorColor?: string;
      macros?: Record<string, string>;
      trust?: boolean;
    },
  ): void;
}
