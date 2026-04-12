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
import { resolve, relative, extname, basename } from 'node:path';
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
import { logDebug, logWarning } from '../shared/logger.js';

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
 * Parses a single source file and returns its ComponentAnalysis.
 * Returns null if the file cannot be parsed or contains no interactive elements.
 */
function parseSourceFile(
  filePath: string,
  sourceDirectory: string,
): ComponentAnalysis | null {
  const sourceCode = readFileSync(filePath, 'utf-8');
  const fileExtension = extname(filePath).toLowerCase();

  // Determine parser plugins based on file type
  const parserPlugins: babelParser.ParserPlugin[] = ['jsx'];
  if (fileExtension === '.ts' || fileExtension === '.tsx') {
    parserPlugins.push('typescript');
  }

  let astRoot: babelTypes.File;
  try {
    astRoot = babelParser.parse(sourceCode, {
      sourceType: 'module',
      plugins: parserPlugins,
      errorRecovery: true, // Parse as much as possible even with minor syntax issues
    });
  } catch (parseError) {
    logWarning(`Could not parse ${filePath}: ${String(parseError)}`);
    return null;
  }

  const discoveredElements: InteractiveElement[] = [];
  const importedComponents: string[] = [];

  // Walk the AST to find interactive elements and imports
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
 * Discovers all parseable source files in a directory, respecting exclude patterns.
 */
async function discoverSourceFiles(
  sourceDirectory: string,
  excludePatterns: string[],
): Promise<string[]> {
  // glob requires forward slashes even on Windows — normalize backslashes to forward slashes
  const normalizedSourceDirectory = sourceDirectory.replace(/\\/g, '/');
  const globPattern = `${normalizedSourceDirectory}/**/*{${PARSEABLE_EXTENSIONS.join(',')}}`;
  const discoveredFiles = await glob(globPattern, {
    ignore: excludePatterns,
    absolute: true,
  });

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
 * This is the entry point for Phase 1 of the EZTest synthesis pipeline.
 * The returned analyses are passed to the FlowMapper and then the TestGenerator.
 */
export async function analyzeSourceDirectory(
  options: CodeAnalyzerOptions,
): Promise<ComponentAnalysis[]> {
  const { sourceDirectory, excludePatterns, maxFileCount } = options;
  const resolvedSourceDirectory = resolve(sourceDirectory);

  const sourceFiles = await discoverSourceFiles(resolvedSourceDirectory, excludePatterns);
  const filesToAnalyze = sourceFiles.slice(0, maxFileCount);

  if (sourceFiles.length > maxFileCount) {
    logWarning(
      `Found ${sourceFiles.length} source files but maxFileCount is ${maxFileCount}. ` +
      `Analyzing first ${maxFileCount} files. Increase maxComponentCount in your config to analyze more.`
    );
  }

  const componentAnalyses: ComponentAnalysis[] = [];

  for (const filePath of filesToAnalyze) {
    logDebug(`Analyzing: ${relative(resolvedSourceDirectory, filePath)}`);
    const analysis = parseSourceFile(filePath, resolvedSourceDirectory);
    if (analysis) {
      componentAnalyses.push(analysis);
    }
  }

  logDebug(`Completed analysis: ${componentAnalyses.length} components with interactive elements`);
  return componentAnalyses;
}
