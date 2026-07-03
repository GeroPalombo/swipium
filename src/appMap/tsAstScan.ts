// Vision Gap Fix 10 — AST-based JS/TS/TSX route + screen + symbol discovery using the TypeScript
// compiler API, with the regex scanner as a fallback. Regex misses common navigation patterns it can't
// resolve: a route name passed through a constant (`<Stack.Screen name={ROUTES.Weather} .../>`), a
// multiline default-export component, or `navigation.navigate(ROUTES.Weather)`. This module parses the
// source, resolves route-constant references, and returns structured screens/edges/route-constants plus
// parserNotes (parse failures reduce confidence, never hard-fail). `typescript` is loaded lazily via
// createRequire so projects without it cleanly fall back to the regex scanner.

import { createRequire } from 'node:module';
import { extname } from 'node:path';

export interface TsScreen {
  name: string; // resolved route name when available, else the symbol/component name
  route?: string;
  component?: string; // the component bound to the screen (Stack.Screen component={X})
  kind: 'screen' | 'component';
  confidence: number;
  reasons: string[];
}

export interface TsNavEdge {
  to: string; // resolved route name
  kind: 'navigation';
  via: string; // e.g. "navigation.navigate"
}

export interface TsRouteConstant {
  name: string; // e.g. ROUTES.Weather
  value: string;
}

export interface TsScanResult {
  parsed: boolean; // true only when the TS compiler API was available and parsing succeeded
  screens: TsScreen[];
  navEdges: TsNavEdge[];
  routeConstants: TsRouteConstant[];
  parserNotes: string[];
}

const SCREEN_SUFFIX = /(Screen|Page|View)$/;
const NAV_SCREEN_TAG = /\.(Screen)$/;

let tsCache: typeof import('typescript') | null | undefined;
/** Lazily load the TypeScript compiler API (sync); returns null when the package isn't resolvable. */
function loadTs(): typeof import('typescript') | null {
  if (tsCache !== undefined) return tsCache;
  try {
    const require = createRequire(import.meta.url);
    tsCache = require('typescript') as typeof import('typescript');
  } catch {
    tsCache = null;
  }
  return tsCache;
}

/** Whether the TS compiler API is available in this environment (for callers deciding on fallback). */
export function tsAstAvailable(): boolean {
  return loadTs() !== null;
}

function scriptKindFor(ts: typeof import('typescript'), fileName: string): import('typescript').ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
      return ts.ScriptKind.TS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.mjs':
    case '.cjs':
    case '.js':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TSX;
  }
}

/**
 * Parse a single JS/TS source file and extract screens, navigation edges, and route constants.
 * Returns parsed:false (empty result) when the TS compiler API is unavailable — the caller then uses
 * the regex scanner. Never throws: a parse error is recorded in parserNotes.
 */
export function scanTsSource(fileName: string, text: string): TsScanResult {
  const empty: TsScanResult = { parsed: false, screens: [], navEdges: [], routeConstants: [], parserNotes: [] };
  const ts = loadTs();
  if (!ts) return empty;

  let sf: import('typescript').SourceFile;
  try {
    sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, fileName));
  } catch (e) {
    return { ...empty, parsed: false, parserNotes: [`AST parse failed for ${fileName}: ${String(e)}`] };
  }

  const screens: TsScreen[] = [];
  const navEdges: TsNavEdge[] = [];
  const routeConstants: TsRouteConstant[] = [];
  const parserNotes: string[] = [];
  // Resolution map: both "ROUTES.Weather" → "WeatherAnalysis" and bare "Weather" → "WeatherAnalysis".
  const constMap = new Map<string, string>();

  const addScreen = (s: TsScreen) => {
    if (!s.name) return;
    if (screens.some((x) => x.name === s.name && x.component === s.component)) return;
    screens.push(s);
  };

  // First pass: collect route-constant objects so later JSX/name references resolve to values.
  const collectConsts = (node: import('typescript').Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
          const objName = decl.name.text;
          for (const prop of decl.initializer.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
              ts.isStringLiteralLike(prop.initializer)
            ) {
              const key = (prop.name as import('typescript').Identifier | import('typescript').StringLiteral).text;
              const value = prop.initializer.text;
              constMap.set(`${objName}.${key}`, value);
              if (!constMap.has(key)) constMap.set(key, value);
              if (/route/i.test(objName)) routeConstants.push({ name: `${objName}.${key}`, value });
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectConsts);
  };
  try {
    collectConsts(sf);
  } catch (e) {
    parserNotes.push(`route-constant collection failed: ${String(e)}`);
  }

  const resolveNameExpr = (expr: import('typescript').Expression): string | undefined => {
    if (ts.isStringLiteralLike(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) {
      const full = `${expr.expression.getText(sf)}.${expr.name.text}`;
      return constMap.get(full) ?? constMap.get(expr.name.text);
    }
    if (ts.isIdentifier(expr)) return constMap.get(expr.text) ?? expr.text;
    return undefined;
  };

  const jsxAttrValue = (attrs: import('typescript').JsxAttributes, attrName: string): string | undefined => {
    for (const a of attrs.properties) {
      if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== attrName) continue;
      const init = a.initializer;
      if (!init) return undefined;
      if (ts.isStringLiteral(init)) return init.text;
      if (ts.isJsxExpression(init) && init.expression) {
        if (ts.isStringLiteralLike(init.expression)) return init.expression.text;
        return resolveNameExpr(init.expression);
      }
    }
    return undefined;
  };

  const visit = (node: import('typescript').Node): void => {
    // Exported default React components (default export of a function/class/identifier).
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const expr = node.expression;
      const name = ts.isIdentifier(expr) ? expr.text : undefined;
      if (name)
        addScreen({
          name,
          kind: SCREEN_SUFFIX.test(name) ? 'screen' : 'component',
          component: name,
          confidence: 0.7,
          reasons: ['ast_default_export_component'],
        });
    }

    // function/class components, incl. `export default function FooScreen()` spanning lines.
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const isDefault = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      if (SCREEN_SUFFIX.test(name) || isDefault) {
        addScreen({
          name,
          kind: SCREEN_SUFFIX.test(name) ? 'screen' : 'component',
          component: name,
          confidence: SCREEN_SUFFIX.test(name) ? 0.75 : 0.6,
          reasons: [isDefault ? 'ast_default_export_function' : 'ast_function_component'],
        });
      }
    }
    if (ts.isClassDeclaration(node) && node.name && SCREEN_SUFFIX.test(node.name.text)) {
      addScreen({ name: node.name.text, kind: 'screen', component: node.name.text, confidence: 0.7, reasons: ['ast_class_component'] });
    }
    // const FooScreen = (...) => (...)  /  = function () {}
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          SCREEN_SUFFIX.test(decl.name.text) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
        ) {
          addScreen({ name: decl.name.text, kind: 'screen', component: decl.name.text, confidence: 0.7, reasons: ['ast_arrow_component'] });
        }
      }
    }

    // <Stack.Screen name={ROUTES.Weather} component={WeatherAnalysisScreen} />
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const tag = node.tagName.getText(sf);
      if (NAV_SCREEN_TAG.test(tag)) {
        const name = jsxAttrValue(node.attributes, 'name');
        const component = jsxAttrValue(node.attributes, 'component');
        if (name) {
          addScreen({ name, route: name, component, kind: 'screen', confidence: 0.85, reasons: ['ast_navigator_screen', `tag_${tag}`] });
        }
      }
    }

    // navigation.navigate(ROUTES.Weather) / .push(...) / .replace(...)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (/^(navigate|push|replace)$/.test(method) && node.arguments.length) {
        const to = resolveNameExpr(node.arguments[0]);
        if (to) navEdges.push({ to, kind: 'navigation', via: `${node.expression.expression.getText(sf)}.${method}` });
      }
    }

    ts.forEachChild(node, visit);
  };

  try {
    visit(sf);
  } catch (e) {
    parserNotes.push(`AST walk failed for ${fileName}: ${String(e)}`);
  }

  return { parsed: true, screens, navEdges, routeConstants, parserNotes };
}
