/**
 * Code Analyzer — the first stage of the AI Test Synthesizer pipeline.
 *
 * Crawls a source directory, parses each component/page file using Babel's AST parser,
 * and extracts every interactive element it can find. The goal is NOT to understand
 * business logic here — just to extract the raw signals (text, aria labels, handler names,
 * element types) that the AI will later interpret into user-facing behavior.
 *
 * Supports: React/JSX, TypeScript/TSX. Vue/Angular support is via the plugin system.
 */
import { readFileSync } from 'node:fs';
import { resolve, relative, extname, basename, join } from 'node:path';
import { glob } from 'glob';
import * as babelParser from '@babel/parser';
import babelTraverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as babelTypes from '@babel/types';

// @babel/traverse has a quirk with ESM/CJS interop — the actual function may be on .default.
// The @types/babel__traverse typings are also incomplete, so we cast to avoid TS errors
// while still getting the correct runtime behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverseAst = ((babelTraverse as any).default ?? babelTraverse) as (
  ast: babelTypes.File,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  visitors: Record<string, (path: NodePath<any>) => void>,
) => void;
import type { ComponentAnalysis, InteractiveElement, InteractiveElementKind } from '../shared/types.js';
import { logDebug, logInfo, logWarning } from '../shared/logger.js';

// ── Element Detection Constants ────────────────────────────────────────────

/**
 * JSX element names that map to interactive UI elements.
 * Includes both native HTML and common component library naming conventions.
 */
const INTERACTIVE_ELEMENT_TAG_MAP: Record<string, InteractiveElementKind> = {
  button: 'button',
  Button: 'button',
  a: 'link',
  Link: 'link',
  NavLink: 'link',
  RouterLink: 'link',
  input: 'input',
  Input: 'input',
  textarea: 'textarea',
  Textarea: 'textarea',
  select: 'select',
  Select: 'select',
  form: 'form',
  Form: 'form',
  Checkbox: 'checkbox',
  Switch: 'checkbox',
  Radio: 'radio',
  RadioGroup: 'radio',
  Modal: 'modal-trigger',
  Dialog: 'modal-trigger',
};

/**
 * Attribute names that indicate an element has an interactive purpose via event handling.
 * If an element has any of these props, it's treated as interactive even if its tag isn't in the map.
 */
const INTERACTIVE_EVENT_PROPS = new Set([
  'onClick', 'onChange', 'onSubmit', 'onPress',
  'onBlur', 'onFocus', 'onKeyDown', 'onKeyUp',
]);

/** JSX attribute names that carry accessible text labels — the best semantic signals. */
const ARIA_LABEL_ATTRIBUTE_NAMES = new Set(['aria-label', 'aria-labelledby', 'alt', 'title', 'placeholder']);

/** JSX attribute names used for test selector generation. */
const TEST_ID_ATTRIBUTE_NAMES = new Set(['data-testid', 'data-cy', 'data-test', 'id']);

// ── AST Attribute Extraction Helpers ──────────────────────────────────────

/**
 * Extracts a string value from a JSX attribute node.
 * Returns null if the value is dynamic (a JSX expression we can't statically resolve).
 */
function extractStaticStringFromJsxAttribute(
  attributeNode: babelTypes.JSXAttribute,
): string | null {
  if (!attributeNode.value) return null;
  if (babelTypes.isStringLiteral(attributeNode.value)) {
    return attributeNode.value.value;
  }
  // Handle {`template literal`} and {"string"} in JSX expressions
  if (babelTypes.isJSXExpressionContainer(attributeNode.value)) {
    const expression = attributeNode.value.expression;
    if (babelTypes.isStringLiteral(expression)) {
      return expression.value;
    }
    if (babelTypes.isTemplateLiteral(expression) && expression.quasis.length === 1) {
      return expression.quasis[0]?.value.cooked ?? null;
    }
  }
  return null;
}

/**
 * Extracts the name of a function referenced in an event handler prop.
 * For `onClick={handleSubmit}` returns "handleSubmit".
 * For `onClick={() => doThing()}` returns null (anonymous function).
 */
function extractHandlerFunctionName(
  attributeNode: babelTypes.JSXAttribute,
): string | null {
  if (!babelTypes.isJSXExpressionContainer(attributeNode.value)) return null;
  const expression = attributeNode.value.expression;
  if (babelTypes.isIdentifier(expression)) {
    return expression.name;
  }
  // Arrow function wrapping a call: `onClick={() => handleSubmit()}`
  if (
    babelTypes.isArrowFunctionExpression(expression) &&
    babelTypes.isCallExpression(expression.body) &&
    babelTypes.isIdentifier(expression.body.callee)
  ) {
    return expression.body.callee.name;
  }
  return null;
}

/**
 * Extracts visible text content from JSX children nodes.
 * Concatenates string literals and ignores dynamic expressions.
 */
function extractTextFromJsxChildren(
  children: babelTypes.JSXElement['children'],
): string | null {
  const textParts: string[] = [];
  for (const child of children) {
    if (babelTypes.isJSXText(child)) {
      const trimmedText = child.value.trim();
      if (trimmedText) textParts.push(trimmedText);
    }
    if (
      babelTypes.isJSXExpressionContainer(child) &&
      babelTypes.isStringLiteral(child.expression)
    ) {
      textParts.push(child.expression.value);
    }
  }
  return textParts.length > 0 ? textParts.join(' ') : null;
}

// ── JSX Element Analysis ───────────────────────────────────────────────────

/**
 * Analyzes a single JSX opening element and returns an InteractiveElement
 * if the element is interactive, or null if it should be ignored.
 */
function analyzeJsxOpeningElement(
  openingElement: babelTypes.JSXOpeningElement,
  jsxChildren: babelTypes.JSXElement['children'],
  sourceLine: number,
): InteractiveElement | null {
  // Determine the element tag name
  let tagName: string;
  if (babelTypes.isJSXIdentifier(openingElement.name)) {
    tagName = openingElement.name.name;
  } else if (babelTypes.isJSXMemberExpression(openingElement.name)) {
    // e.g., <UI.Button>
    tagName = `${openingElement.name.object}.${openingElement.name.property}`;
  } else {
    return null;
  }

  // Scan attributes for interactive signals and semantic metadata
  let ariaLabel: string | undefined;
  let handlerName: string | undefined;
  let testId: string | undefined;
  const classNames: string[] = [];
  let hasInteractiveEventProp = false;
  let inputTypeValue: string | undefined;

  for (const attribute of openingElement.attributes) {
    if (!babelTypes.isJSXAttribute(attribute)) continue;
    if (!babelTypes.isJSXIdentifier(attribute.name)) continue;

    const attributeName = attribute.name.name;

    if (ARIA_LABEL_ATTRIBUTE_NAMES.has(attributeName)) {
      ariaLabel = extractStaticStringFromJsxAttribute(attribute) ?? undefined;
    }
    if (TEST_ID_ATTRIBUTE_NAMES.has(attributeName)) {
      testId = extractStaticStringFromJsxAttribute(attribute) ?? undefined;
    }
    if (attributeName === 'className' || attributeName === 'class') {
      const classValue = extractStaticStringFromJsxAttribute(attribute);
      if (classValue) classNames.push(...classValue.split(/\s+/).filter(Boolean));
    }
    if (attributeName === 'type') {
      inputTypeValue = extractStaticStringFromJsxAttribute(attribute) ?? undefined;
    }
    if (INTERACTIVE_EVENT_PROPS.has(attributeName)) {
      hasInteractiveEventProp = true;
      handlerName = extractHandlerFunctionName(attribute) ?? undefined;
    }
  }

  // Determine if this element is interactive
  const mappedElementKind = INTERACTIVE_ELEMENT_TAG_MAP[tagName];
  const isInteractiveByTag = mappedElementKind !== undefined;
  const isInteractiveByEvent = hasInteractiveEventProp;

  if (!isInteractiveByTag && !isInteractiveByEvent) return null;

  // Hidden inputs (type="hidden") are not user-interactive
  if (tagName === 'input' && inputTypeValue === 'hidden') return null;

  const elementKind: InteractiveElementKind = mappedElementKind ?? 'other';
  const textContent = extractTextFromJsxChildren(jsxChildren) ?? undefined;

  return {
    elementKind,
    textContent,
    ariaLabel,
    handlerName,
    testId,
    classNames: classNames.length > 0 ? classNames : undefined,
    tagName,
    sourceLine,
  };
}

// ── Component Name Inference ───────────────────────────────────────────────

/**
 * Infers the component name from the file name.
 * For "UserProfilePage.tsx" returns "UserProfilePage".
 * For "index.tsx" falls back to the parent directory name.
 */
function inferComponentNameFromFilePath(filePath: string, sourceDirectory: string): string {
  const relativeFilePath = relative(sourceDirectory, filePath);
  const fileExtension = extname(relativeFilePath);
  const fileBaseName = basename(relativeFilePath, fileExtension);

  if (fileBaseName === 'index') {
    // Use the parent directory name instead (e.g., "checkout/index.tsx" → "checkout")
    const parentDirectoryName = basename(resolve(filePath, '..'));
    return parentDirectoryName;
  }

  return fileBaseName;
}

// ── File Parsing ───────────────────────────────────────────────────────────

/**
 * Traverses the AST of a parsed file and collects all interactive JSX elements
 * and PascalCase import names. Extracted into its own function to keep
 * parseSourceFile under the 40-line limit and make each concern independently testable.
 */
function extractInteractiveElementsAndImports(
  astRoot: babelTypes.File,
): { discoveredElements: InteractiveElement[]; importedComponents: string[] } {
  const discoveredElements: InteractiveElement[] = [];
  const importedComponents: string[] = [];

  traverseAst(astRoot, {
    JSXElement(nodePath: NodePath<babelTypes.JSXElement>) {
      const openingElement = nodePath.node.openingElement;
      const children = nodePath.node.children;
      const sourceLine = openingElement.loc?.start.line ?? 0;

      const interactiveElement = analyzeJsxOpeningElement(openingElement, children, sourceLine);
      if (interactiveElement) {
        discoveredElements.push(interactiveElement);
      }
    },
    ImportDeclaration(nodePath: NodePath<babelTypes.ImportDeclaration>) {
      // Collect imported component names for flow mapping (e.g., import { Modal } from './Modal')
      for (const specifier of nodePath.node.specifiers) {
        if (babelTypes.isImportDefaultSpecifier(specifier) || babelTypes.isImportSpecifier(specifier)) {
          const importedName = babelTypes.isImportSpecifier(specifier)
            ? (babelTypes.isIdentifier(specifier.imported) ? specifier.imported.name : '')
            : specifier.local.name;
          // Only track imports that look like component names (PascalCase)
          if (importedName && /^[A-Z]/.test(importedName)) {
            importedComponents.push(importedName);
          }
        }
      }
    },
  });

  return { discoveredElements, importedComponents };
}

/**
 * Parses a single source file and returns its ComponentAnalysis.
 * Returns null if the file is unreadable, cannot be parsed, or contains no interactive elements.
 *
 * readFileSync is intentionally inside the try/catch so that permission errors,
 * locked files, and overly-long paths all produce a warning and graceful null return
 * instead of crashing the entire analysis run.
 */
function parseSourceFile(
  filePath: string,
  sourceDirectory: string,
): ComponentAnalysis | null {
  const fileExtension = extname(filePath).toLowerCase();
  const parserPlugins: babelParser.ParserPlugin[] = ['jsx'];
  if (fileExtension === '.ts' || fileExtension === '.tsx') {
    parserPlugins.push('typescript');
  }

  let sourceCode: string;
  let astRoot: babelTypes.File;
  try {
    // Both readFileSync and parse are inside the try/catch — any unreadable or
    // syntactically broken file produces a warning rather than crashing the run.
    sourceCode = readFileSync(filePath, 'utf-8');
    astRoot = babelParser.parse(sourceCode, {
      sourceType: 'module',
      plugins: parserPlugins,
      errorRecovery: true, // Parse as much as possible even with minor syntax issues
    });
  } catch (parseError) {
    logWarning(`Could not parse ${filePath}: ${String(parseError)}`);
    return null;
  }

  const { discoveredElements, importedComponents } = extractInteractiveElementsAndImports(astRoot);

  if (discoveredElements.length === 0) {
    logDebug(`No interactive elements found in ${filePath}, skipping`);
    return null;
  }

  const componentName = inferComponentNameFromFilePath(filePath, sourceDirectory);

  return {
    filePath,
    componentName,
    interactiveElements: discoveredElements,
    importedComponents,
    detectedFramework: 'react',
    sourceCode,
  };
}

// ── Source File Discovery ──────────────────────────────────────────────────

/** File extensions the code analyzer will attempt to parse. */
const PARSEABLE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

/**
 * Extra glob ignore patterns always applied during file discovery — regardless of caller config.
 * Catches generated artifacts (Storybook stories, declaration stubs, minified bundles, build
 * output, mock fixtures, and test files) that never contain user-facing UI flows worth testing.
 *
 * NOTE: Test and spec files are included here as a safety net even though callers typically
 * also pass them via globalExcludePatterns. Server-side test files in routes/ directories
 * score 100 (highest tier) because of their parent directory — without explicit exclusion
 * they would consume the entire top-N file budget with zero interactive UI elements.
 */
const ADDITIONAL_EXCLUDE_PATTERNS: string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/*.story.*',
  '**/*.d.ts',
  '**/*.min.js',
  '**/.next/**',
  '**/build/**',
  '**/out/**',
  '**/vendor/**',
  '**/.turbo/**',
  '**/coverage/**',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/mocks/**',
  '**/migrations/**',
  '**/storybook-static/**',
];

// ── Priority Scoring Constants ─────────────────────────────────────────────

/**
 * Directory names that strongly indicate user-facing UI flows.
 * A file nested inside any of these directories gets the highest priority score.
 */
const HIGH_VALUE_DIRECTORY_NAMES = new Set(['pages', 'routes', 'views', 'screens', 'app']);

/**
 * Exact component file names (without extension) that are almost always
 * entry points or top-level navigation components worth testing first.
 */
const EXACT_HIGH_VALUE_COMPONENT_NAMES = new Set([
  'App', 'Router', 'Navigation', 'NavBar', 'Navbar', 'Sidebar',
  'Layout', 'Header', 'Footer', 'Home', 'Dashboard',
  'Login', 'Register', 'Signup', 'Checkout', 'Cart',
]);

/** Filename suffixes that indicate a full-page or screen-level component. */
const PAGE_LEVEL_SUFFIXES = ['Page', 'Screen', 'View', 'Route'] as const;

/** Filename suffixes that indicate a focused form or overlay — still high value. */
const FORM_LEVEL_SUFFIXES = ['Form', 'Modal', 'Dialog', 'Wizard', 'Drawer'] as const;

/** Score assigned when the file lives in a high-value directory (pages, routes, etc.). */
const SCORE_TIER_HIGH_VALUE_DIRECTORY = 100;
/** Score assigned when the filename exactly matches a known entry-point component. */
const SCORE_TIER_EXACT_COMPONENT_NAME = 90;
/** Score assigned when the filename ends with a page-level suffix. */
const SCORE_TIER_PAGE_LEVEL_SUFFIX = 70;
/** Score assigned when the filename ends with a form/overlay suffix. */
const SCORE_TIER_FORM_LEVEL_SUFFIX = 50;
/** Score assigned to shallow files (≤ 3 levels deep from source directory). */
const SCORE_TIER_SHALLOW_DEPTH = 30;
/** Fallback score for all other files. */
const SCORE_TIER_DEFAULT = 10;

/** Maximum path depth (in segments from the source directory) to qualify for the shallow score tier. */
const MAX_SHALLOW_PATH_DEPTH = 3;

// ── Priority Scoring Helpers ───────────────────────────────────────────────

/**
 * Returns the number of path segments between the source directory and the file.
 * Used as a tiebreaker within the same priority score tier: shallower files first.
 *
 * Example: sourceDir/components/Button.tsx → depth 2
 */
function calculatePathDepth(filePath: string, sourceDirectory: string): number {
  const relativeFilePath = relative(sourceDirectory, filePath);
  return relativeFilePath.split(/[/\\]/).length;
}

/**
 * Scores a source file by how likely it is to contain a user-facing UI flow.
 * Higher scores mean the file should be analyzed before lower-scoring files.
 *
 * This function drives the priority sort in analyzeSourceDirectory so that
 * when maxFileCount forces us to truncate, we keep the most valuable files.
 */
function scoreFileByImportance(filePath: string, sourceDirectory: string): number {
  const relativeFilePath = relative(sourceDirectory, filePath);
  const pathSegments = relativeFilePath.split(/[/\\]/);

  // Strip the filename from the path to get only directory segments
  const directorySegments = pathSegments.slice(0, -1);
  const fileNameWithExtension = pathSegments[pathSegments.length - 1] ?? '';
  const fileBaseName = basename(fileNameWithExtension, extname(fileNameWithExtension));

  // Rule 1: File lives inside a high-value directory at any depth
  const isInHighValueDirectory = directorySegments.some(
    segment => HIGH_VALUE_DIRECTORY_NAMES.has(segment),
  );
  if (isInHighValueDirectory) return SCORE_TIER_HIGH_VALUE_DIRECTORY;

  // Rule 2: Filename exactly matches a known top-level component name
  if (EXACT_HIGH_VALUE_COMPONENT_NAMES.has(fileBaseName)) return SCORE_TIER_EXACT_COMPONENT_NAME;

  // Rule 3: Filename ends with a page-level suffix (UserProfilePage, CheckoutScreen, etc.)
  const hasPageLevelSuffix = PAGE_LEVEL_SUFFIXES.some(suffix => fileBaseName.endsWith(suffix));
  if (hasPageLevelSuffix) return SCORE_TIER_PAGE_LEVEL_SUFFIX;

  // Rule 4: Filename ends with a form/overlay suffix (LoginForm, ConfirmModal, etc.)
  const hasFormLevelSuffix = FORM_LEVEL_SUFFIXES.some(suffix => fileBaseName.endsWith(suffix));
  if (hasFormLevelSuffix) return SCORE_TIER_FORM_LEVEL_SUFFIX;

  // Rule 5: Shallow file — within 3 levels of the source root, likely a top-level component
  if (pathSegments.length <= MAX_SHALLOW_PATH_DEPTH) return SCORE_TIER_SHALLOW_DEPTH;

  return SCORE_TIER_DEFAULT;
}

/**
 * Discovers all parseable source files in a directory, applying both the caller-supplied
 * exclude patterns and the built-in ADDITIONAL_EXCLUDE_PATTERNS that filter out
 * generated artifacts (stories, type stubs, build output) regardless of project config.
 */
async function discoverSourceFiles(
  sourceDirectory: string,
  excludePatterns: string[],
): Promise<string[]> {
  // IMPORTANT: On Windows, glob's ignore patterns only work correctly when the
  // main glob pattern is RELATIVE (not absolute). With an absolute pattern like
  // "C:/foo/**/*.ts", glob returns absolute paths with Windows backslashes, and
  // relative ignore patterns like "**/node_modules/**" fail to match because
  // minimatch splits on "/" but the path uses "\".
  //
  // Fix: Use cwd + relative pattern so glob works with relative paths throughout,
  // then manually resolve each result back to absolute after filtering is complete.
  const relativeGlobPattern = `**/*{${PARSEABLE_EXTENSIONS.join(',')}}`;

  // Always exclude the additional patterns on top of whatever the caller provides
  const allExcludePatterns = [...excludePatterns, ...ADDITIONAL_EXCLUDE_PATTERNS];

  const relativeFiles = await glob(relativeGlobPattern, {
    cwd: sourceDirectory,
    ignore: allExcludePatterns,
    nodir: true, // Prevent directories named like *.js (e.g. node_modules/ipaddr.js) from being returned
  });

  // Resolve each relative path back to an absolute path rooted at sourceDirectory
  const discoveredFiles = relativeFiles.map(relativeFilePath => join(sourceDirectory, relativeFilePath));

  logDebug(`Discovered ${discoveredFiles.length} source files in ${sourceDirectory}`);
  return discoveredFiles;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for the code analyzer. */
export interface CodeAnalyzerOptions {
  sourceDirectory: string;
  excludePatterns: string[];
  /** Hard limit on files analyzed to prevent runaway API costs downstream. */
  maxFileCount: number;
}

/**
 * Analyzes an entire source directory and returns a ComponentAnalysis for each
 * file that contains interactive UI elements.
 *
 * Files are sorted by UI importance score before applying the maxFileCount limit,
 * so when the project exceeds the limit we always analyze the most valuable files first
 * (pages, routes, high-value component names) rather than arbitrary filesystem order.
 *
 * This is the entry point for Phase 1 of the EZTest synthesis pipeline.
 * The returned analyses are passed to the FlowMapper and then the TestGenerator.
 */
export async function analyzeSourceDirectory(
  options: CodeAnalyzerOptions,
): Promise<ComponentAnalysis[]> {
  const { sourceDirectory, excludePatterns, maxFileCount } = options;
  const resolvedSourceDirectory = resolve(sourceDirectory);

  const sourceFiles = await discoverSourceFiles(resolvedSourceDirectory, excludePatterns);

  // Sort by descending importance score so that if we must truncate we keep the
  // files most likely to contain user-facing flows. Depth is the tiebreaker:
  // within the same score tier, shallower files come first.
  const prioritizedFiles = [...sourceFiles]
    .sort((fileA, fileB) => {
      const scoreA = scoreFileByImportance(fileA, resolvedSourceDirectory);
      const scoreB = scoreFileByImportance(fileB, resolvedSourceDirectory);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return calculatePathDepth(fileA, resolvedSourceDirectory) - calculatePathDepth(fileB, resolvedSourceDirectory);
    })
    .slice(0, maxFileCount);

  if (sourceFiles.length > maxFileCount) {
    logInfo(
      `Found ${sourceFiles.length} source files — prioritized top ${maxFileCount} files by UI importance.`,
    );
  }

  const componentAnalyses: ComponentAnalysis[] = [];

  for (const filePath of prioritizedFiles) {
    logDebug(`Analyzing: ${relative(resolvedSourceDirectory, filePath)}`);
    const analysis = parseSourceFile(filePath, resolvedSourceDirectory);
    if (analysis) componentAnalyses.push(analysis);
  }

  logDebug(`Completed analysis: ${componentAnalyses.length} components with interactive elements`);
  return componentAnalyses;
}
