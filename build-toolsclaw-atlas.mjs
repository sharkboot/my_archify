// Build the toolsclaw nested drill-down IR from the real source tree.
//
// Every leaf carries verbatim source read from disk, so the generated HTML can
// never drift from the code it documents. Run from the archify skill root:
//
//   node build-toolsclaw-atlas.mjs
//
// Emits toolsclaw-atlas.architecture.json beside this script.

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = 'E:/LLM/toolsclaw/toolsclaw';
const OUT = path.resolve('toolsclaw-atlas.architecture.json');
const REPO_URL = 'https://github.com/example/toolsclaw';
const REVISION = '0'.repeat(40);

const cache = new Map();
function fileLines(relativePath) {
  if (!cache.has(relativePath)) {
    const absolute = path.join(SOURCE_ROOT, relativePath);
    cache.set(relativePath, fs.readFileSync(absolute, 'utf8').split('\n'));
  }
  return cache.get(relativePath);
}

// Slice a 1-based inclusive line range out of a real file. This is the whole
// point of the exercise: the artifact shows the actual implementation.
function slice(relativePath, startLine, endLine) {
  const lines = fileLines(relativePath);
  const end = endLine || lines.length;
  return lines.slice(startLine - 1, end).join('\n').replace(/\s+$/, '');
}

function source(relativePath, startLine, endLine, label) {
  return {
    path: relativePath,
    ...(startLine ? { line: startLine } : {}),
    ...(endLine ? { endLine } : {}),
    ...(label ? { label } : {}),
  };
}

// A code leaf: full detail, never a summary.
function code(file, symbol, startLine, endLine, options = {}) {
  return {
    kind: 'code',
    title: options.title || symbol.split('.').pop(),
    symbol,
    language: 'python',
    ...(options.signature ? { signature: options.signature } : {}),
    ...(options.doc ? { doc: options.doc } : {}),
    ...(options.fields?.length ? { fields: options.fields } : {}),
    ...(options.methods?.length ? { methods: options.methods } : {}),
    ...(options.notes?.length ? { notes: options.notes } : {}),
    sources: startLine ? [source(file, startLine, endLine, options.sourceLabel)] : [source(file)],
    code: slice(file, startLine || 1, endLine),
  };
}

function diagram(title, components, connectors, options = {}) {
  return {
    kind: 'diagram',
    title,
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    components,
    ...(connectors?.length ? { connectors } : {}),
    ...(options.cards?.length ? { cards: options.cards } : {}),
  };
}

// --- modules ---------------------------------------------------------------

// runner.py — AgentRunner is the heart of the framework, so it gets a full
// class-level leaf AND a nested level breaking out its real methods.
const runnerComponents = [
  {
    id: 'init', type: 'backend', label: '__init__', pos: [40, 40],
    summary: 'Resolves workspace, provider, skills, tool registry, then hooks.',
    detail: code('runner.py', 'AgentRunner.__init__', 72, 98, {
      signature: 'def __init__(self, config: Config, *, skills_dir: Path | str | None = None, hook: AgentHook | None = None) -> None',
      fields: [
        { name: '_config', type: 'Config', doc: 'Root configuration object.' },
        { name: '_workspace', type: 'Path', doc: 'Resolved working directory, created if absent.' },
        { name: '_provider', type: 'LLMProvider', doc: 'OpenAI-compatible chat client.' },
        { name: '_registry', type: 'ToolRegistry', doc: 'Name → Tool map exposed to the LLM.' },
        { name: '_deps_ready', type: 'bool', doc: 'Guards one-shot skill dependency install.' },
        { name: '_last_run_usage', type: '_TokenAccumulator', doc: 'Per-run token counters.' },
      ],
      notes: ['Hook setup order matters: memory hooks wrap the user hook, so the composite runs memory first.'],
    }),
  },
  {
    id: 'setup-hooks', type: 'security', label: '_setup_hooks', pos: [276, 40],
    summary: 'Wraps optional hooks into one composite.',
    detail: code('runner.py', 'AgentRunner._setup_hooks', 100, 141, {
      notes: ['A single hook is returned bare rather than wrapped, so callers keep identity.'],
    }),
  },
  {
    id: 'register-tools', type: 'backend', label: '_register_tools', pos: [512, 40],
    summary: 'Registers built-in tools conditionally on config.',
    detail: code('runner.py', 'AgentRunner._register_tools', 189, 213, {
      notes: ['run_script is only registered when at least one skill declares pip requirements.'],
    }),
  },
  {
    id: 'sysprompt', type: 'backend', label: '_build_system_prompt', pos: [748, 40],
    summary: 'Assembles the three-level progressive disclosure prompt.',
    detail: code('runner.py', 'AgentRunner._build_system_prompt', 227, 267),
  },
  {
    id: 'run-sync', type: 'backend', variant: 'emphasis', label: '_run_sync', pos: [40, 200],
    summary: 'Non-streaming tool-calling loop.',
    detail: code('runner.py', 'AgentRunner._run_sync', 284, 358, {
      signature: 'async def _run_sync(self, user_message: str) -> str',
      doc: 'The core agent loop: call the model, execute any tool calls, feed results back, and repeat until the model answers without tools or max_iterations is reached.',
      notes: [
        'Iteration budget comes from config.max_iterations; exhausting it returns an error string rather than raising.',
        'Tool failures are captured into tool_errors but do not break the loop — the model sees the error text as a tool result.',
      ],
    }),
  },
  {
    id: 'run-streaming', type: 'backend', variant: 'emphasis', label: '_run_streaming', pos: [276, 200],
    summary: 'Streaming variant of the same loop.',
    detail: code('runner.py', 'AgentRunner._run_streaming', 360, 446, {
      signature: 'async def _run_streaming(self, user_message: str) -> AsyncIterator[str]',
      notes: ['Yields content deltas; tool execution still happens between chunks, not interleaved.'],
    }),
  },
  {
    id: 'ensure-deps', type: 'cloud', label: '_ensure_deps', pos: [512, 200],
    summary: 'One-shot async skill dependency install.',
    detail: code('runner.py', 'AgentRunner._ensure_deps', 215, 225, {
      notes: ['Re-registers run_script afterwards in case skills only became available post-install.'],
    }),
  },
  {
    id: 'run-interactive', type: 'frontend', label: 'run_interactive', pos: [748, 200],
    summary: 'REPL loop for terminal use.',
    detail: code('runner.py', 'AgentRunner.run_interactive', 448, 490),
  },
];

const runnerConnectors = [
  { id: 'c1', from: 'init', to: 'setup-hooks', label: 'wires', variant: 'emphasis' },
  { id: 'c2', from: 'init', to: 'register-tools', label: 'wires' },
  { id: 'c3', from: 'setup-hooks', to: 'sysprompt', label: 'hook chain' },
  { id: 'c4', from: 'run-sync', to: 'ensure-deps', label: 'awaits first' },
  { id: 'c5', from: 'run-sync', to: 'register-tools', label: 'reads schemas' },
  { id: 'c6', from: 'run-streaming', to: 'ensure-deps', label: 'awaits first' },
  { id: 'c7', from: 'run-interactive', to: 'run-sync', label: 'drives', variant: 'dashed' },
];

// tool.py — the Tool ABC and the registry, each with the full class source.
const toolComponents = [
  {
    id: 'tool-abc', type: 'backend', label: 'Tool (ABC)', pos: [40, 40],
    summary: 'Abstract base every tool implements.',
    detail: code('tool.py', 'Tool', 11, 38, {
      methods: [
        { name: 'name', signature: 'def name(self) -> str', doc: 'Required. Function-call name exposed to the LLM.' },
        { name: 'description', signature: 'def description(self) -> str', doc: 'Required. Shown to the model for tool selection.' },
        { name: 'parameters', signature: 'def parameters(self) -> dict[str, Any]', doc: 'Required. JSON Schema for the tool input.' },
        { name: 'execute', signature: 'async def execute(self, **kwargs: Any) -> str', doc: 'Required. Runs the tool, returns a string result.' },
        { name: 'to_schema', signature: 'def to_schema(self) -> dict[str, Any]', doc: 'Concrete. Emits the OpenAI function-calling schema.' },
      ],
      notes: ['Four of the five members are @abc.abstractmethod; only to_schema has a body.'],
    }),
  },
  {
    id: 'registry', type: 'backend', label: 'ToolRegistry', pos: [300, 40],
    summary: 'Name → Tool map with a cached schema list.',
    detail: code('tool.py', 'ToolRegistry', 41, 70, {
      fields: [
        { name: '_tools', type: 'dict[str, Tool]', doc: 'Registered tools by name.' },
        { name: '_definitions', type: 'list[dict] | None', doc: 'Cached schema list; invalidated on register().' },
      ],
      methods: [
        { name: 'register', signature: 'def register(self, tool: Tool) -> None', doc: 'Adds a tool and invalidates the schema cache.' },
        { name: 'get', signature: 'def get(self, name: str) -> Tool | None', doc: 'Lookup by name.' },
        { name: 'get_definitions', signature: 'def get_definitions(self) -> list[dict[str, Any]]', doc: 'Lazily builds and caches the OpenAI tool array.' },
        { name: 'execute', signature: 'async def execute(self, name: str, arguments: dict[str, Any]) -> str', doc: 'Runs a tool by name, converting exceptions into error strings.' },
      ],
      notes: [
        'execute() never raises: unknown tools and tool exceptions both come back as "Error: ..." strings so one bad tool cannot abort the agent loop.',
      ],
    }),
  },
];

const toolConnectors = [
  { id: 't1', from: 'registry', to: 'tool-abc', label: 'holds instances of', variant: 'emphasis' },
];

// tools/ package — six concrete tools, each fully expanded.
const toolFiles = [
  ['read_file', 'ReadFileTool', 'tools/read_file.py', 'Read a file inside the workspace.'],
  ['write_file', 'WriteFileTool', 'tools/write_file.py', 'Write content to a file inside the workspace.'],
  ['list_dir', 'ListDirTool', 'tools/list_dir.py', 'List a directory inside the workspace.'],
  ['exec_tool', 'ExecTool', 'tools/exec_tool.py', 'Run a shell command with deny-pattern and workspace containment.'],
  ['run_script', 'RunScriptTool', 'tools/run_script.py', 'Run a skill script inside its own venv.'],
  ['load_skill', 'LoadSkillTool', 'tools/load_skill.py', 'Load a skill body into context on demand.'],
];

function toolLeaf(file, className, doc, index) {
  const lines = fileLines(file);
  const start = lines.findIndex((line) => line.startsWith(`class ${className}`)) + 1;
  const body = lines.slice(start - 1);
  // Trim to the end of the class: the next top-level def/class, or EOF.
  let end = body.length;
  for (let i = 1; i < body.length; i += 1) {
    if (/^(class |def )/.test(body[i])) { end = i; break; }
  }
  const absoluteEnd = start + end - 1;
  return {
    id: className.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
    type: index % 2 === 0 ? 'backend' : 'cloud',
    label: className,
    pos: [40 + (index % 3) * 236, 40 + Math.floor(index / 3) * 180],
    summary: doc,
    detail: code(file, className, start, absoluteEnd, { doc, sourceLabel: className }),
  };
}

const toolsComponents = toolFiles.map(([file, className, filePath, doc], index) =>
  toolLeaf(filePath, className, doc, index));

// --- top level -------------------------------------------------------------
//
// One left-to-right spine (cli -> sdk -> runner -> provider), with short
// branches leaving the nearest main-path node. Side modules sit directly under
// the node they belong to so no relationship has to cross an unrelated box.

const topComponents = [
  {
    id: 'cli', type: 'frontend', label: 'cli', pos: [40, 240],
    sublabel: 'typer CLI', tag: '13 commands',
    summary: 'Command-line surface: init, run, chat, and the memory subcommands.',
    detail: code('cli.py', 'cli', 1, 399, {
      title: 'cli.py',
      methods: [
        { name: 'init', signature: 'def init(workspace: str = typer.Option(""))', doc: 'Create config + workspace.' },
        { name: 'run', signature: 'def run(message: str, ...)', doc: 'One-shot agent run.' },
        { name: 'chat', signature: 'def chat(...)', doc: 'Interactive REPL.' },
        { name: 'memory_add / memory_search / memory_link_graph / ...', doc: 'Ten memory management commands over MemoryStore.' },
      ],
      notes: ['_resolve_memory_store() is the shared helper every memory command funnels through.'],
    }),
  },
  {
    id: 'sdk', type: 'frontend', label: 'sdk', pos: [250, 240],
    sublabel: 'ToolsClaw facade', tag: 'RunResult',
    summary: 'Programmatic facade wrapping AgentRunner for embedding.',
    detail: code('sdk.py', 'ToolsClaw', 68, 289, {
      title: 'ToolsClaw facade + RunResult',
      methods: [
        { name: 'from_config', signature: '@classmethod def from_config(cls, config_path=None, *, workspace=None, skills_dir=None, model=None, api_key=None)', doc: 'Builds a runner from config plus overrides.' },
        { name: 'from_runner', signature: '@classmethod def from_runner(cls, runner: AgentRunner)', doc: 'Wraps an existing runner.' },
        { name: 'run', signature: 'async def run(self, message: str, ...) -> RunResult', doc: 'Runs one message, returning content plus usage and memory counters.' },
        { name: 'stream_run', signature: 'async def stream_run(self, message: str, ...)', doc: 'Streaming variant.' },
      ],
      notes: ['SDKCaptureHook records tool usage and messages so RunResult can report tools_used and full history.'],
    }),
  },
  {
    id: 'config', type: 'backend', label: 'config', pos: [250, 480],
    sublabel: 'pydantic models', tag: 'JSON file',
    summary: 'Pydantic configuration models and load/save/init helpers.',
    detail: diagram('config.py — configuration', [
      {
        id: 'root-config', type: 'backend', label: 'Config', pos: [40, 40],
        summary: 'Root model: model, provider, workspace, sandbox, max_iterations.',
        detail: code('config.py', 'Config', 74, 101, {
          fields: [
            { name: 'model', type: 'str', value: '"deepseek/deepseek-chat"' },
            { name: 'provider', type: 'str', value: '"auto"' },
            { name: 'workspace', type: 'str' },
            { name: 'sandbox', type: 'bool', value: 'True' },
            { name: 'max_iterations', type: 'int', value: '100', doc: 'Bounds the agent loop.' },
            { name: 'providers', type: 'dict[str, ProviderConfig]' },
            { name: 'exec / memory / persistent_memory', doc: 'Nested config blocks.' },
          ],
          methods: [
            { name: 'get_provider_config', signature: 'def get_provider_config(self) -> ProviderConfig', doc: 'Explicit provider wins; otherwise first with an api_key.' },
            { name: 'get_workspace', signature: 'def get_workspace(self) -> Path', doc: 'Expands and resolves, defaulting to cwd.' },
          ],
        }),
      },
      {
        id: 'exec-config', type: 'security', label: 'ExecConfig', pos: [300, 40],
        summary: 'Shell execution settings including the deny-pattern list.',
        detail: code('config.py', 'ExecConfig', 19, 34, {
          fields: [
            { name: 'enable', type: 'bool', value: 'True' },
            { name: 'timeout', type: 'int', value: '60' },
            { name: 'deny_patterns', type: 'list[str]', doc: 'Regexes blocking rm -rf /, mkfs, dd if=, fork bombs, shutdown, reboot.' },
          ],
          notes: ['deny_patterns is the security boundary for ExecTool; keep it in sync with _check_deny.'],
        }),
      },
      {
        id: 'mem-config', type: 'database', label: 'MemoryCompressionConfig', pos: [560, 40],
        summary: 'Compression trigger and target ratio.',
        detail: code('config.py', 'MemoryCompressionConfig', 36, 55, {
          fields: [
            { name: 'enabled', type: 'bool', value: 'False' },
            { name: 'strategy', type: 'str', value: '"hybrid"' },
            { name: 'threshold_tokens', type: 'int', value: '80_000' },
            { name: 'target_ratio', type: 'float', value: '0.5' },
            { name: 'min_rounds_to_keep', type: 'int', value: '3' },
            { name: 'tool_result_max_chars', type: 'int', value: '300' },
          ],
        }),
      },
      {
        id: 'pm-config', type: 'database', label: 'PersistentMemoryConfig', pos: [820, 40],
        summary: 'Persistent memory toggle and recall budget.',
        detail: code('config.py', 'PersistentMemoryConfig', 58, 71, {
          fields: [
            { name: 'enabled', type: 'bool', value: 'False' },
            { name: 'auto_save', type: 'bool', value: 'True' },
            { name: 'max_memories', type: 'int', value: '5', doc: 'How many memories get injected per iteration.' },
            { name: 'memory_dir', type: 'str', doc: 'Empty means <workspace>/.claude/memory/.' },
          ],
        }),
      },
    ], []),
  },
  {
    id: 'runner', type: 'backend', label: 'runner', pos: [470, 240],
    sublabel: 'AgentRunner', tag: 'core loop',
    summary: 'The LLM tool-calling loop: iterate, execute tools, feed results back.',
    detail: diagram('runner.py — AgentRunner', runnerComponents, runnerConnectors, {
      subtitle: 'The agent loop and everything AgentRunner wires together at construction time.',
    }),
  },
  {
    id: 'hook', type: 'security', label: 'hook', pos: [470, 480],
    sublabel: 'lifecycle hooks', tag: '4 hooks',
    summary: 'before/after callbacks around each iteration, plus memory and SDK capture hooks.',
    detail: diagram('hook.py — lifecycle', [
      {
        id: 'agent-hook', type: 'security', label: 'AgentHook', pos: [40, 40],
        summary: 'Base class with four overridable methods.',
        detail: code('hook.py', 'AgentHook', 35, 56, {
          methods: [
            { name: 'before_iteration', signature: 'async def before_iteration(self, context: AgentHookContext) -> None', doc: 'Called before each LLM request.' },
            { name: 'before_execute_tools', signature: 'async def before_execute_tools(self, context: AgentHookContext) -> None', doc: 'After the model returns tool calls, before execution.' },
            { name: 'after_iteration', signature: 'async def after_iteration(self, context: AgentHookContext) -> None', doc: 'After tool results are collected.' },
            { name: 'finalize_content', signature: 'def finalize_content(self, context, content: str | None) -> str | None', doc: 'Post-processes the final response text.' },
          ],
        }),
      },
      {
        id: 'ctx', type: 'cloud', label: 'AgentHookContext', pos: [300, 40],
        summary: 'Mutable per-iteration state handed to every hook.',
        detail: code('hook.py', 'AgentHookContext', 23, 33, {
          fields: [
            { name: 'iteration', type: 'int' },
            { name: 'messages', type: 'list[dict[str, Any]]' },
            { name: 'response', type: 'LLMResponse | None' },
            { name: 'tool_calls', type: 'list[ToolCallRequest]' },
            { name: 'tool_results', type: 'list[str]' },
            { name: 'tool_errors', type: 'list[str]' },
            { name: 'final_content', type: 'str | None' },
          ],
        }),
      },
      {
        id: 'composite', type: 'backend', label: 'CompositeHook', pos: [560, 40],
        summary: 'Fans one lifecycle call out to many hooks in order.',
        detail: code('hook.py', 'CompositeHook', 75, 100),
      },
      {
        id: 'mem-compress', type: 'backend', label: 'MemoryCompressionHook', pos: [40, 230],
        summary: 'Compresses history when the token estimate crosses the threshold.',
        detail: code('hook.py', 'MemoryCompressionHook', 102, 186),
      },
      {
        id: 'persistent-mem', type: 'database', label: 'PersistentMemoryHook', pos: [300, 230],
        summary: 'Recalls relevant memories before each iteration and auto-saves after.',
        detail: code('hook.py', 'PersistentMemoryHook', 188, 490),
      },
      {
        id: 'sdk-capture', type: 'backend', label: 'SDKCaptureHook', pos: [560, 230],
        summary: 'Records tool usage for RunResult.',
        detail: code('hook.py', 'SDKCaptureHook', 58, 73),
      },
    ], [
      { id: 'h1', from: 'agent-hook', to: 'ctx', label: 'receives' },
      { id: 'h2', from: 'composite', to: 'agent-hook', label: 'extends', variant: 'emphasis' },
      { id: 'h3', from: 'mem-compress', to: 'agent-hook', label: 'extends', variant: 'dashed' },
      { id: 'h4', from: 'persistent-mem', to: 'agent-hook', label: 'extends', variant: 'dashed' },
      { id: 'h5', from: 'sdk-capture', to: 'agent-hook', label: 'extends', variant: 'dashed' },
    ]),
  },
  {
    id: 'memory', type: 'backend', label: 'memory', pos: [470, 720],
    sublabel: 'compression', tag: '4 strategies',
    summary: 'Token estimation and four message-history compression strategies.',
    detail: diagram('memory.py — compression', [
      {
        id: 'strategy', type: 'cloud', label: 'CompressionStrategy', pos: [40, 40],
        summary: 'Enum of the four strategies.',
        detail: code('memory.py', 'CompressionStrategy', 17, 30, {
          fields: [
            { name: 'TRUNCATE', doc: 'Drop whole older rounds.' },
            { name: 'DROP_TOOL_RESULTS', doc: 'Truncate tool result text only.' },
            { name: 'SUMMARIZE', doc: 'Replace older rounds with an LLM summary.' },
            { name: 'HYBRID', doc: 'Summarize then trim to target ratio.' },
          ],
        }),
      },
      {
        id: 'compressor', type: 'backend', label: 'MemoryCompressor', pos: [300, 40],
        summary: 'Public compression API and token accounting.',
        detail: code('memory.py', 'MemoryCompressor', 228, 415, {
          methods: [
            { name: 'estimate_tokens', signature: 'def estimate_tokens(self, messages) -> int' },
            { name: 'should_compress', signature: 'def should_compress(self, messages, threshold_tokens) -> bool' },
            { name: 'compress', signature: 'async def compress(self, messages, strategy=HYBRID, target_ratio=0.5, min_rounds_to_keep=3, tool_result_max_chars=300)' },
            { name: '_summarize_compress', signature: 'async def _summarize_compress(self, messages, target_ratio, min_rounds_to_keep)' },
            { name: '_hybrid_compress', signature: 'async def _hybrid_compress(self, messages, target_ratio, min_rounds_to_keep, tool_result_max_chars)' },
            { name: '_make_fallback_summary', signature: 'def _make_fallback_summary(self, ...)' },
          ],
          notes: ['summarize_func is injected by the runner so the compressor never owns provider credentials.'],
        }),
      },
    ], [{ id: 'm1', from: 'compressor', to: 'strategy', label: 'selects' }]),
  },
  {
    id: 'persistent-memory', type: 'database', label: 'persistent_memory', pos: [700, 720],
    sublabel: 'Memory + MemoryStore', tag: 'markdown + YAML',
    summary: 'File-backed memory: markdown with YAML frontmatter, indexed by MEMORY.md.',
    detail: diagram('persistent_memory.py — storage', [
      {
        id: 'memory-model', type: 'database', label: 'Memory', pos: [40, 40],
        summary: 'One memory entry with frontmatter serialization.',
        detail: code('persistent_memory.py', 'Memory', 62, 260, {
          fields: [
            { name: '_name', type: 'str', doc: 'Kebab-case slug; validated on construction.' },
            { name: '_description', type: 'str', doc: 'One-line summary used for recall relevance.' },
            { name: '_type', type: 'str', doc: 'One of user | feedback | project | reference.' },
            { name: '_content', type: 'str', doc: 'The fact body.' },
            { name: '_links', type: 'list[str]', doc: '[[name]] links extracted from content, merged with explicit links.' },
            { name: '_created_at / _updated_at', type: 'datetime', doc: 'UTC timestamps, auto-set when omitted.' },
          ],
          methods: [
            { name: 'to_frontmatter', signature: 'def to_frontmatter(self) -> str', doc: 'Renders the markdown file with YAML frontmatter.' },
            { name: 'from_frontmatter', signature: '@classmethod def from_frontmatter(cls, text: str, file_path: Path | None = None)', doc: 'Parses a memory file back into an object.' },
            { name: 'to_index_line', signature: 'def to_index_line(self) -> str', doc: 'One MEMORY.md index row.' },
          ],
          notes: ['The name regex ^[a-z][a-z0-9-]*$ and the VALID_TYPES set are both enforced in __init__, so an invalid memory cannot be constructed.'],
        }),
      },
      {
        id: 'store', type: 'database', label: 'MemoryStore', pos: [300, 40],
        summary: 'Persistence, search, link graph, dedupe, and consolidation.',
        detail: code('persistent_memory.py', 'MemoryStore', 264, 815, {
          methods: [
            { name: 'save / load / delete / list_memories / exists', doc: 'Basic CRUD over the memory directory.' },
            { name: 'search', signature: 'def search(self, query: str, *, max_results: int = 10) -> list[Memory]' },
            { name: 'find_by_type', signature: 'def find_by_type(self, type_: str, *, max_results: int = 20)' },
            { name: 'rebuild_index', signature: 'def rebuild_index(self) -> str', doc: 'Regenerates MEMORY.md from the files on disk.' },
            { name: 'find_related', signature: 'def find_related(self, name: str) -> list[Memory]' },
            { name: 'get_link_graph', signature: 'def get_link_graph(self) -> dict[str, list[str]]' },
            { name: 'find_duplicates', signature: 'def find_duplicates(self) -> list[tuple[Memory, Memory]]' },
            { name: 'consolidate', signature: 'def consolidate(self, dry_run: bool = True) -> dict[str, Any]' },
            { name: 'stats', signature: 'def stats(self) -> dict[str, Any]' },
            { name: 'update_or_create', signature: 'def update_or_create(self, ...)' },
            { name: 'import_memories', signature: 'def import_memories(self, source_dir: str | Path) -> int' },
          ],
        }),
      },
    ], [{ id: 'pm1', from: 'store', to: 'memory-model', label: 'serializes', variant: 'emphasis' }]),
  },
  {
    id: 'provider', type: 'cloud', label: 'provider', pos: [700, 240],
    sublabel: 'OpenAI API', tag: 'stream + tools',
    summary: 'Chat client, response dataclasses, and conversation history with compression.',
    detail: diagram('provider.py — LLM access', [
      {
        id: 'llm-provider', type: 'cloud', label: 'LLMProvider', pos: [40, 40],
        summary: 'AsyncOpenAI wrapper with tool calling.',
        detail: code('provider.py', 'LLMProvider', 46, 183, {
          methods: [
            { name: 'chat', signature: 'async def chat(self, messages, tools=None) -> LLMResponse' },
            { name: 'stream_chat', signature: 'async def stream_chat(self, messages, tools=None)' },
          ],
          notes: ['api_key falls back to the literal "none" so a local OpenAI-compatible server works without credentials.'],
        }),
      },
      {
        id: 'llm-response', type: 'backend', label: 'LLMResponse', pos: [300, 40],
        summary: 'Unified response with content, tool calls, finish reason, usage.',
        detail: code('provider.py', 'LLMResponse', 33, 43, {
          fields: [
            { name: 'content', type: 'str' },
            { name: 'tool_calls', type: 'list[ToolCallRequest]' },
            { name: 'finish_reason', type: 'str' },
            { name: 'usage', type: 'TokenUsage' },
          ],
          methods: [{ name: 'has_tool_calls', signature: '@property def has_tool_calls(self) -> bool' }],
        }),
      },
      {
        id: 'conversation', type: 'database', label: 'Conversation', pos: [560, 40],
        summary: 'Message history with optional compression on send.',
        detail: code('provider.py', 'Conversation', 185, 355, {
          methods: [
            { name: 'messages', signature: '@property def messages(self) -> list[dict[str, Any]]' },
            { name: 'reset', signature: 'def reset(self) -> None' },
            { name: 'set_system_prompt', signature: 'def set_system_prompt(self, content: str) -> None' },
            { name: 'compress', signature: 'async def compress(self, ...)' },
            { name: 'send', signature: 'async def send(self, ...)' },
            { name: 'stream_send', signature: 'async def stream_send(self, ...)' },
          ],
        }),
      },
    ], [
      { id: 'p1', from: 'llm-provider', to: 'llm-response', label: 'returns', variant: 'emphasis' },
      { id: 'p2', from: 'conversation', to: 'llm-provider', label: 'sends via', variant: 'dashed' },
    ]),
  },
  {
    id: 'tool', type: 'backend', label: 'tool', pos: [930, 240],
    sublabel: 'ABC + registry', tag: 'contract',
    summary: 'The Tool abstract base class and the ToolRegistry container.',
    detail: diagram('tool.py — tool contract', toolComponents, toolConnectors),
  },
  {
    id: 'tools-package', type: 'backend', label: 'tools/', pos: [930, 480],
    sublabel: '6 built-in tools', tag: 'sandboxed',
    summary: 'The concrete tools registered by AgentRunner.',
    detail: diagram('tools/ — built-in tools', toolsComponents, [
      { id: 'tp1', from: 'read-file-tool', to: 'list-dir-tool', label: 'same workspace guard', variant: 'dashed' },
    ], {
      subtitle: 'Every tool resolves its target against the workspace and refuses to escape it.',
    }),
  },
  {
    id: 'skills', type: 'cloud', label: 'skills', pos: [930, 720],
    sublabel: 'requirements', tag: 'per-skill venv',
    summary: 'Skill discovery, frontmatter parsing, and per-skill dependency resolution.',
    detail: code('skills.py', 'skills', 1, 246, {
      title: 'skills.py',
      fields: [
        { name: 'Skill.name / .description / .always', doc: 'From SKILL.md frontmatter.' },
        { name: 'Skill.content', doc: 'Body without frontmatter.' },
        { name: 'Skill.requires', type: 'SkillRequirements', doc: 'bins / env / pip.' },
        { name: 'Skill.available', type: 'bool', doc: 'False when requirements are unmet.' },
      ],
      methods: [
        { name: 'venv_dir', signature: '@property def venv_dir(self) -> Path', doc: 'Per-skill venv beside SKILL.md.' },
        { name: 'get_python', signature: 'def get_python(self) -> str', doc: 'venv interpreter, or sys.executable.' },
        { name: 'load_skills / build_skills_summary / get_always_skills / ensure_skill_deps', doc: 'Module-level helpers used by AgentRunner.' },
      ],
    }),
  },
];

// The spine carries the request path; each side module hangs directly beneath
// the node that owns it, so no relationship crosses an unrelated component.
const topConnectors = [
  { id: 'e1', from: 'cli', to: 'sdk', label: 'delegates', variant: 'emphasis' },
  { id: 'e2', from: 'sdk', to: 'runner', label: 'drives', variant: 'emphasis' },
  { id: 'e3', from: 'runner', to: 'provider', label: 'chat + tools', variant: 'emphasis' },
  { id: 'e4', from: 'runner', to: 'tool', label: 'executes via registry', fromSide: 'top', toSide: 'top', via: [[530, 180], [990, 180]], labelAt: [760, 172] },
  { id: 'e5', from: 'runner', to: 'hook', label: 'lifecycle callbacks', variant: 'security', fromSide: 'bottom', toSide: 'top', labelAt: [530, 400] },
  { id: 'e6', from: 'tool', to: 'tools-package', label: 'implemented by', variant: 'emphasis', fromSide: 'bottom', toSide: 'top', labelAt: [990, 400] },
  { id: 'e7', from: 'hook', to: 'memory', label: 'compresses with', variant: 'dashed', fromSide: 'bottom', toSide: 'top', labelAt: [420, 620] },
  { id: 'e8', from: 'hook', to: 'persistent-memory', label: 'recalls + saves', variant: 'dashed', fromSide: 'right', toSide: 'left', labelAt: [635, 620] },
  { id: 'e9', from: 'sdk', to: 'config', label: 'configured by', fromSide: 'bottom', toSide: 'top', labelAt: [310, 400] },
  { id: 'e10', from: 'runner', to: 'skills', label: 'loads', variant: 'dashed', fromSide: 'top', toSide: 'right', via: [[530, 140], [1160, 140], [1160, 750]], labelAt: [700, 132] },
];

const document = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: {
    title: 'toolsclaw — Ultra-lightweight tool-calling agent framework',
    quality_profile: 'showcase',
    viewBox: [1330, 950],
    views: [
      { id: 'request-path', label: 'Request path', focus: ['cli', 'sdk', 'runner', 'provider'], note: 'Follow one user message from the CLI into the agent loop and out to the model.' },
      { id: 'tool-execution', label: 'Tool execution', focus: ['runner', 'tool', 'tools-package'], note: 'Trace how the model tool calls reach a concrete sandboxed tool.' },
      { id: 'memory-layer', label: 'Memory and hooks', focus: ['runner', 'hook', 'memory', 'persistent-memory'], note: 'Compression and persistent recall both run as lifecycle hooks.' },
    ],
  },
  components: topComponents,
  boundaries: [
    { kind: 'region', label: 'toolsclaw package', wraps: ['cli', 'sdk', 'runner', 'hook', 'memory', 'persistent-memory', 'provider', 'skills', 'config', 'tools-package', 'tool'] },
  ],
  connections: topConnectors,
  cards: [
    { dot: 'cyan', title: 'How to read this', items: [
      'Single-click any node for its full detail: fields, methods, and line-linked source.',
      'Double-click a node marked with the open badge to descend into its own diagram.',
      'The breadcrumb above the diagram walks back out; Esc steps back one level.',
    ] },
    { dot: 'emerald', title: 'Core loop', items: [
      'AgentRunner._run_sync iterates up to config.max_iterations.',
      'Each round: call the model, execute any tool calls, append results, repeat.',
      'ToolRegistry.execute converts exceptions into error strings so one failure cannot abort the run.',
    ] },
    { dot: 'rose', title: 'Safety boundaries', items: [
      'ExecTool enforces workspace containment plus a deny-pattern list from ExecConfig.',
      'Every file tool resolves and checks its target stays under the workspace.',
      'Persistent memory validates names and types at construction time.',
    ] },
  ],
};

fs.writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${OUT}`);
console.log(`components: ${document.components.length}`);
