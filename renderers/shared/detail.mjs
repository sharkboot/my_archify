// Nested drill-down detail validation and traversal.
//
// `components[].detail` is a recursive payload: either a nested diagram (which
// recurses through its own components) or a leaf code artifact (which
// terminates). The committed standalone validator in `generated-validators.mjs`
// is generated upstream from the JSON Schemas and predates this field, so it
// cannot be regenerated inside this package. Rather than hand-editing generated
// code, `validateSchema` strips `detail` before calling the committed validator
// and this module owns the contract for everything under it.
//
// Depth is unbounded by design: the user asked to descend until a node has
// nothing left to open. `MAX_DETAIL_DEPTH` is a corruption guard, not a feature
// limit -- it only exists so a pathological or self-referential document cannot
// hang the renderer.

import { throwDiagnosticProblems } from './diagnostics.mjs';

export const MAX_DETAIL_DEPTH = 64;
export const MAX_DETAIL_NODES = 20000;

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const COMPONENT_TYPES = new Set([
  'frontend', 'backend', 'database', 'cloud', 'security', 'messagebus', 'external',
]);
const VARIANTS = new Set(['default', 'emphasis', 'security', 'dashed']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value) {
  return value === undefined || typeof value === 'string';
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length <= max;
}

// A dialog-free path reporter: `/components/2/detail/components/0/detail`.
function joinPath(base, ...segments) {
  return [base, ...segments].filter((segment) => segment !== '' && segment !== undefined).join('/');
}

function requireObject(value, path, problems, label) {
  if (!isPlainObject(value)) {
    problems.push(`${path} ${label} must be an object.`);
    return false;
  }
  return true;
}

// Reject unknown keys so `additionalProperties: false` semantics survive the
// hand-written path. Keeps a typo like `method` from silently doing nothing.
function rejectUnknownKeys(value, allowed, path, problems) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(`${path} must NOT have additional property ${JSON.stringify(key)}.`);
    }
  }
}

const SOURCE_KEYS = new Set(['path', 'line', 'endLine', 'label']);
const MEMBER_KEYS = new Set(['name', 'signature', 'type', 'value', 'doc', 'code', 'variant']);
const CODE_KEYS = new Set([
  'kind', 'title', 'subtitle', 'symbol', 'language', 'signature', 'doc',
  'sources', 'fields', 'methods', 'code', 'notes',
]);
const DIAGRAM_KEYS = new Set(['kind', 'title', 'subtitle', 'components', 'connectors', 'cards']);
const DETAIL_COMPONENT_KEYS = new Set([
  'id', 'type', 'label', 'sublabel', 'tag', 'variant', 'pos', 'size', 'summary', 'detail',
]);
const CONNECTOR_KEYS = new Set(['id', 'from', 'to', 'label', 'variant', 'fromSide', 'toSide', 'via']);
const CARD_KEYS = new Set(['dot', 'title', 'items']);

export function validateDetailSources(sources, path, problems) {
  if (!Array.isArray(sources)) {
    problems.push(`${path} must be an array.`);
    return;
  }
  sources.forEach((source, index) => {
    const sourcePath = joinPath(path, String(index));
    if (!requireObject(source, sourcePath, problems, 'source')) return;
    rejectUnknownKeys(source, SOURCE_KEYS, sourcePath, problems);
    if (!isNonEmptyString(source.path) || source.path.length > 240) {
      problems.push(`${sourcePath}/path must be a non-empty string of at most 240 characters.`);
    } else if (source.path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(source.path) || source.path.includes('\\')) {
      // Repository evidence resolves git-relative POSIX paths; an absolute or
      // Windows-style path can never verify and would fail later with a
      // confusing message, so reject it at authoring time.
      problems.push(`${sourcePath}/path must be a repo-relative POSIX path.`);
    }
    for (const key of ['line', 'endLine']) {
      if (source[key] !== undefined && (!Number.isInteger(source[key]) || source[key] < 1)) {
        problems.push(`${sourcePath}/${key} must be an integer >= 1.`);
      }
    }
    if (Number.isInteger(source.line) && Number.isInteger(source.endLine) && source.endLine < source.line) {
      problems.push(`${sourcePath}/endLine must be >= line.`);
    }
    if (source.label !== undefined && !boundedString(source.label, 48)) {
      problems.push(`${sourcePath}/label must be a string of at most 48 characters.`);
    }
  });
}

function validateMembers(members, path, problems) {
  if (!Array.isArray(members)) {
    problems.push(`${path} must be an array.`);
    return;
  }
  members.forEach((member, index) => {
    const memberPath = joinPath(path, String(index));
    if (!requireObject(member, memberPath, problems, 'member')) return;
    rejectUnknownKeys(member, MEMBER_KEYS, memberPath, problems);
    if (!isNonEmptyString(member.name) || member.name.length > 160) {
      problems.push(`${memberPath}/name must be a non-empty string of at most 160 characters.`);
    }
    for (const [key, max] of [['signature', 2000], ['type', 400], ['value', 4000], ['doc', 4000], ['code', 200000]]) {
      if (member[key] !== undefined && !boundedString(member[key], max)) {
        problems.push(`${memberPath}/${key} must be a string of at most ${max} characters.`);
      }
    }
    if (member.variant !== undefined && !VARIANTS.has(member.variant)) {
      problems.push(`${memberPath}/variant must be one of ${JSON.stringify([...VARIANTS])}.`);
    }
  });
}

function validatePosition(component, path, problems) {
  if (component.pos !== undefined) {
    if (!Array.isArray(component.pos) || component.pos.length !== 2
      || !component.pos.every(isFiniteNumber)) {
      problems.push(`${path}/pos must be an array of exactly two finite numbers.`);
    }
  }
  if (component.size !== undefined) {
    if (!Array.isArray(component.size) || component.size.length !== 2
      || !component.size.every((value) => isFiniteNumber(value) && value > 0)) {
      problems.push(`${path}/size must be an array of exactly two positive numbers.`);
    }
  }
}

export function validateDetailComponent(component, path, problems, depth, remaining) {
  if (!requireObject(component, path, problems, 'component')) return;
  rejectUnknownKeys(component, DETAIL_COMPONENT_KEYS, path, problems);
  if (!isNonEmptyString(component.id) || !ID_PATTERN.test(component.id)) {
    problems.push(`${path}/id must match ${String(ID_PATTERN)}.`);
  }
  if (!COMPONENT_TYPES.has(component.type)) {
    problems.push(`${path}/type must be one of ${JSON.stringify([...COMPONENT_TYPES])}.`);
  }
  if (!isNonEmptyString(component.label)) {
    problems.push(`${path}/label must be a non-empty string.`);
  }
  for (const key of ['sublabel', 'tag', 'summary']) {
    if (!isOptionalString(component[key])) {
      problems.push(`${path}/${key} must be a string.`);
    }
  }
  if (component.summary !== undefined && !boundedString(component.summary, 2000)) {
    problems.push(`${path}/summary must be a string of at most 2000 characters.`);
  }
  if (component.variant !== undefined && !VARIANTS.has(component.variant)) {
    problems.push(`${path}/variant must be one of ${JSON.stringify([...VARIANTS])}.`);
  }
  validatePosition(component, path, problems);
  if (component.detail !== undefined) {
    validateDetailPayload(component.detail, joinPath(path, 'detail'), problems, depth + 1, remaining);
  }
}

function validateCodeArtifact(detail, path, problems) {
  rejectUnknownKeys(detail, CODE_KEYS, path, problems);
  if (!isNonEmptyString(detail.title) || detail.title.length > 160) {
    problems.push(`${path}/title must be a non-empty string of at most 160 characters.`);
  }
  for (const key of ['subtitle', 'signature', 'doc', 'code']) {
    if (detail[key] !== undefined && !isOptionalString(detail[key])) {
      problems.push(`${path}/${key} must be a string.`);
    }
  }
  if (!isNonEmptyString(detail.symbol) || detail.symbol.length > 300) {
    problems.push(`${path}/symbol is required and must be a non-empty string of at most 300 characters.`);
  }
  if (detail.language !== undefined && (!isNonEmptyString(detail.language) || detail.language.length > 40)) {
    problems.push(`${path}/language must be a non-empty string of at most 40 characters.`);
  }
  if (detail.sources !== undefined) {
    validateDetailSources(detail.sources, joinPath(path, 'sources'), problems);
  }
  for (const key of ['fields', 'methods']) {
    if (detail[key] !== undefined) {
      validateMembers(detail[key], joinPath(path, key), problems);
    }
  }
  if (detail.notes !== undefined) {
    if (!Array.isArray(detail.notes)) {
      problems.push(`${path}/notes must be an array.`);
    } else {
      detail.notes.forEach((note, index) => {
        if (!boundedString(note, 4000)) {
          problems.push(`${joinPath(path, 'notes', String(index))} must be a string of at most 4000 characters.`);
        }
      });
    }
  }
}

function validateNestedDiagram(detail, path, problems, depth, remaining) {
  rejectUnknownKeys(detail, DIAGRAM_KEYS, path, problems);
  if (!isNonEmptyString(detail.title) || detail.title.length > 160) {
    problems.push(`${path}/title must be a non-empty string of at most 160 characters.`);
  }
  if (detail.subtitle !== undefined && !boundedString(detail.subtitle, 2000)) {
    problems.push(`${path}/subtitle must be a string of at most 2000 characters.`);
  }
  if (!Array.isArray(detail.components) || detail.components.length === 0) {
    problems.push(`${path}/components must be a non-empty array.`);
  } else {
    const seen = new Set();
    detail.components.forEach((component, index) => {
      const componentPath = joinPath(path, 'components', String(index));
      validateDetailComponent(component, componentPath, problems, depth, remaining);
      if (isPlainObject(component) && isNonEmptyString(component.id)) {
        if (seen.has(component.id)) {
          problems.push(`${componentPath}/id duplicates component id ${JSON.stringify(component.id)} in the same nested level.`);
        }
        seen.add(component.id);
      }
    });
    const connectors = detail.connectors;
    if (connectors !== undefined) {
      if (!Array.isArray(connectors)) {
        problems.push(`${path}/connectors must be an array.`);
      } else {
        const connectorIds = new Set();
        connectors.forEach((connector, index) => {
          const connectorPath = joinPath(path, 'connectors', String(index));
          if (!requireObject(connector, connectorPath, problems, 'connector')) return;
          rejectUnknownKeys(connector, CONNECTOR_KEYS, connectorPath, problems);
          for (const key of ['from', 'to']) {
            if (!isNonEmptyString(connector[key])) {
              problems.push(`${connectorPath}/${key} is required and must be a non-empty string.`);
            } else if (!seen.has(connector[key])) {
              problems.push(`${connectorPath}/${key} references unknown component id ${JSON.stringify(connector[key])}.`);
            }
          }
          if (connector.id !== undefined) {
            if (!isNonEmptyString(connector.id) || !ID_PATTERN.test(connector.id)) {
              problems.push(`${connectorPath}/id must match ${String(ID_PATTERN)}.`);
            } else if (connectorIds.has(connector.id)) {
              problems.push(`${connectorPath}/id duplicates connector id ${JSON.stringify(connector.id)}.`);
            }
            connectorIds.add(connector.id);
          }
          if (connector.label !== undefined && !boundedString(connector.label, 200)) {
            problems.push(`${connectorPath}/label must be a string of at most 200 characters.`);
          }
          if (connector.variant !== undefined && !VARIANTS.has(connector.variant)) {
            problems.push(`${connectorPath}/variant must be one of ${JSON.stringify([...VARIANTS])}.`);
          }
          const SIDE_VALUES = new Set(['left', 'right', 'top', 'bottom', 'auto']);
          for (const key of ['fromSide', 'toSide']) {
            if (connector[key] !== undefined && !SIDE_VALUES.has(connector[key])) {
              problems.push(`${connectorPath}/${key} must be one of ${JSON.stringify([...SIDE_VALUES])}.`);
            }
          }
          if (connector.via !== undefined) {
            if (!Array.isArray(connector.via)) {
              problems.push(`${connectorPath}/via must be an array.`);
            } else {
              connector.via.forEach((point, viaIndex) => {
                const viaPath = joinPath(connectorPath, 'via', String(viaIndex));
                if (!Array.isArray(point) || point.length !== 2 || !point.every((v) => isFiniteNumber(v))) {
                  problems.push(`${viaPath} must be an array of exactly two finite numbers.`);
                }
              });
            }
          }
        });
      }
    }
    if (detail.cards !== undefined) {
      if (!Array.isArray(detail.cards)) {
        problems.push(`${path}/cards must be an array.`);
      } else {
        detail.cards.forEach((card, index) => {
          const cardPath = joinPath(path, 'cards', String(index));
          if (!requireObject(card, cardPath, problems, 'card')) return;
          rejectUnknownKeys(card, CARD_KEYS, cardPath, problems);
          if (!Array.isArray(card.items)) {
            problems.push(`${cardPath}/items must be an array.`);
          }
        });
      }
    }
  }
}

export function validateDetailPayload(detail, path, problems, depth = 0, remaining = { count: 0 }) {
  if (!requireObject(detail, path, problems, 'detail')) return;
  if (depth > MAX_DETAIL_DEPTH) {
    // A document that reaches this is either corrupt or genuinely
    // self-referential; refuse instead of recursing without bound.
    problems.push(`${path} exceeds the maximum supported drill-down depth of ${MAX_DETAIL_DEPTH}.`);
    return;
  }
  remaining.count += 1;
  if (remaining.count > MAX_DETAIL_NODES) {
    problems.push(`${path} exceeds the maximum supported drill-down node count of ${MAX_DETAIL_NODES}.`);
    return;
  }
  const kind = detail.kind;
  if (kind === 'code') {
    validateCodeArtifact(detail, path, problems);
    return;
  }
  if (kind === 'diagram') {
    validateNestedDiagram(detail, path, problems, depth, remaining);
    return;
  }
  problems.push(`${path}/kind must be "diagram" or "code".`);
}

// Entry point used by loadDiagram. Validates every `components[].detail` in the
// top-level architecture document and reports through the shared diagnostic
// pipeline so `--json` receipts, supportedFixes, and the CLI exit codes behave
// exactly like schema and guided-view failures.
export function validateDetailPayloads(diagramType, diagram) {
  if (diagramType !== 'architecture') return;
  const components = Array.isArray(diagram?.components) ? diagram.components : [];
  const problems = [];
  const remaining = { count: 0 };
  components.forEach((component, index) => {
    if (!isPlainObject(component)) return;
    // `summary` is a renderer extension on the top-level component, so it is
    // stripped before the committed validator runs and checked here instead.
    if (component.summary !== undefined && !boundedString(component.summary, 2000)) {
      problems.push(`/components/${index}/summary must be a string of at most 2000 characters.`);
    }
    if (component.detail === undefined) return;
    validateDetailPayload(component.detail, `/components/${index}/detail`, problems, 0, remaining);
  });
  if (problems.length) {
    throwDiagnosticProblems('Detail payload validation failed', problems, {
      code: 'detail/invalid',
      subject: { diagramType, collection: 'components.detail' },
    });
  }
}

// Depth-first walk over every drill-down level, used by the renderer to emit the
// payload and by tests to assert reachability. Yields one entry per node that
// carries a `detail`, paired with its drill-down path.
export function* walkDetails(components, path = '', depth = 0) {
  if (!Array.isArray(components) || depth > MAX_DETAIL_DEPTH) return;
  for (const component of components) {
    if (!isPlainObject(component)) continue;
    const componentPath = path ? `${path}/${component.id}` : String(component.id);
    if (component.detail !== undefined) {
      yield { component, detail: component.detail, path: componentPath, depth };
      if (component.detail?.kind === 'diagram') {
        yield* walkDetails(component.detail.components, componentPath, depth + 1);
      }
    }
  }
}

export function countDetailNodes(components) {
  let count = 0;
  for (const _ of walkDetails(components)) count += 1;
  return count;
}
