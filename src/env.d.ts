declare module "*.txt?raw" {
  const text: string;
  export default text;
}

declare module "*.md?raw" {
  const text: string;
  export default text;
}

declare module "*/LICENSE?raw" {
  const text: string;
  export default text;
}

declare module "*.mjs" {
  export function tableStart(source: string): number;
  export function plainText(text: string, options?: { preserveParagraphBreaks?: boolean }): string;
  export function splitSoftBreaks(markdown: string, hardBreaks: boolean): string;
  export function characterCount(text: string, spaces?: boolean): number;
  export function requiresSource(text: string, options?: { tables?: boolean; links?: boolean; images?: boolean }): boolean;
  export const DEFAULT_TEXT_REPLACEMENTS: {
    id: string;
    from: string;
    to: string;
    enabled: boolean;
    label?: string;
  }[];
  export function normalizeTextReplacements(raw?: any): {
    id: string;
    from: string;
    to: string;
    enabled: boolean;
    label: string;
  }[];
  export function migrateTypingPreferences(prefs?: Record<string, any>): Record<string, any>;
  export function typingPlan(
    before: string,
    selected: string,
    after: string,
    input: string,
    options?: Record<string, any>,
  ): any;
  export function pairedBackspace(
    before: string,
    after: string,
    options?: Record<string, any>,
  ): boolean;
  export function smartClosingEnter(
    before: string,
    after: string,
    options?: Record<string, any>,
  ): boolean;
  export function inMarkdownCode(before: string): boolean;
  export function manuscriptStats(text: string): any;
  export function countForRule(stats: any, rule: string, unit?: string): number;
  export function countForWriting(stats: any, rules: import("./types").WritingRules): number;
  export function novelpiaCount(text: string): number;
  export function writingName(rules: import("./types").WritingRules): string;
  export const platforms: any[];
  export function normalizeWriting(value?: any): import("./types").WritingRules;
  // core/episode.mjs: 회차 상태·유형·속성.
  export const STATUSES: string[];
  export const STATUS_LABELS: Record<string, string>;
  export const STATUS_SHORT: Record<string, string>;
  export function normalizeStatus(status?: string): string;
  export const EPISODE_TYPES: number[];
  export const TYPE_CHOICES: number[];
  export const TYPE_LABELS: Record<number, string>;
  export const TYPE_ACTIONS: Record<number, string>;
  export function normalizeType(type?: number | string): number;
  export function lineBreakLabel(manual?: boolean): string;
  export function lineBreakDefault(project: { manualLineBreak?: boolean } | undefined, common?: boolean): boolean;
  export function episodeNumbers(episodes: { id: string; episodeType?: number }[]): Map<string, string>;
  // core/typesetting.mjs: 편집기 조판 스타일.
  export const FONT_FAMILY_PRESETS: {
    id: string;
    label: string;
    value: string;
  }[];
  export const WIDTH_PRESETS: {
    group: string;
    items: {
      id: string;
      label: string;
      width: number;
    }[];
  }[];
  export const PLATFORM_STYLE_PRESETS: {
    id: string;
    name: string;
    environment: string;
    description: string;
    style: Record<string, any>;
  }[];
  export const DIVIDER_STYLES: {
    id: string;
    label: string;
    description: string;
  }[];
  export const DEFAULT_EDITOR_STYLE: Record<string, any>;
  export const DEFAULT_NOTE_EDITOR_STYLE: Record<string, any>;
  export const TYPESETTING_KINDS: {
    id: "episode" | "document";
    label: string;
    shortLabel: string;
    description: string;
  }[];
  export function resolveKindPrefs(prefs?: Record<string, any>, kind?: string): Record<string, any>;
  export function normalizeEditorStyle(prefs?: Record<string, any>, kind?: string): {
    fontFamily: string;
    fontSize: number;
    fontWeight: number;
    letterSpacing: number;
    lineHeight: number;
    blockGap: number;
    indent: number;
    hardBreakIndent: boolean;
    textAlign: "left" | "justify" | "center" | "right";
    editorMaxWidth: number;
    editorPaddingX: number;
    textareaBgColor: string;
    editorTextColor: string;
    serifSymbols: boolean;
    dividerStyle: "solid" | "short" | "ornament" | "stars";
    dividerPaddingY: number;
    pageViewEnabled: boolean;
    pageViewFlow: "vertical" | "responsive";
  };
  export function replaceManuscriptSymbols(
    markdown: string,
    options?: {
      doubleQuotes?: boolean;
      singleQuotes?: boolean;
      ellipsis?: boolean;
      ellipsisChar?: string;
      emDash?: boolean;
    },
  ): { body: string; count: number };
}
