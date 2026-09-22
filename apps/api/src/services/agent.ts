import type { AgentRun, AgentRunStatus, Prisma } from "@prisma/client";
import type { Config } from "../config.js";
import { prisma } from "../db.js";
import { providerFor } from "../providers/factory.js";
import { ProviderError, type VirtualizationProvider } from "../providers/types.js";
import { performAction, safeActivityMetadata, type ActionContext, type AgentAction } from "./agent-actions.js";
import { browserEvaluate, browserState, captureScreenshot, displayGeometry } from "./desktop.js";
import type { ControlLock } from "./control.js";
import type { ActivityHub } from "./activity.js";

// One agent run is bound to one existing AI Computer. It never creates a computer, it never
// starts a second browser, and it never removes anything: it attaches to the live desktop,
// observes it, acts on it, and detaches, leaving the desktop exactly as it was found.
export const ACTIVE_RUN_STATUSES: AgentRunStatus[] = ["QUEUED", "ATTACHED", "OBSERVING", "ACTING", "WAITING_FOR_HUMAN"];
const TERMINAL_RUN_STATUSES: AgentRunStatus[] = ["COMPLETED", "FAILED", "DETACHED"];
export const WAIT_FOR_HUMAN_TIMEOUT_MS = 20 * 60 * 1000;

export interface RunView {
  id: string; computerId: string; agentName: string; title: string; instruction: string | null;
  recipe: string | null; status: AgentRunStatus; source: string; phase: string | null;
  result: string | null; lastError: string | null; startedAt: string; finishedAt: string | null;
}

export function toRunView(run: AgentRun): RunView {
  return {
    id: run.id, computerId: run.computerId, agentName: run.agentName, title: run.title,
    instruction: run.instruction ?? null, recipe: run.recipe ?? null, status: run.status,
    source: run.source, phase: run.phase ?? null, result: run.result ?? null,
    lastError: run.lastError ?? null, startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null
  };
}

export async function activeRunFor(computerId: string): Promise<AgentRun | null> {
  return prisma.agentRun.findFirst({ where: { computerId, status: { in: ACTIVE_RUN_STATUSES } }, orderBy: { createdAt: "desc" } });
}

export async function latestRunFor(computerId: string): Promise<AgentRun | null> {
  return prisma.agentRun.findFirst({ where: { computerId }, orderBy: { createdAt: "desc" } });
}

export interface AttachInput {
  computerId: string; organizationId: string; ownerId: string; actorId: string; actorKind: "agent" | "human";
  agentName: string; title?: string; instruction?: string | null; recipe?: string | null; source: "agent-api" | "console";
}

export async function createRun(input: AttachInput): Promise<AgentRun> {
  return prisma.agentRun.create({
    data: {
      computerId: input.computerId, organizationId: input.organizationId, ownerId: input.ownerId,
      actorId: input.actorId, actorKind: input.actorKind, agentName: input.agentName,
      title: input.title?.slice(0, 160) || recipeTitle(input.recipe) || "Agent task",
      instruction: input.instruction ?? null, recipe: input.recipe ?? null,
      status: "ATTACHED", source: input.source, phase: "Attached"
    }
  });
}

async function setRun(runId: string, data: Prisma.AgentRunUpdateInput): Promise<AgentRun | null> {
  try { return await prisma.agentRun.update({ where: { id: runId }, data }); }
  catch { return null; }
}

export async function finishRun(runId: string, status: AgentRunStatus, patch: { result?: string; lastError?: string } = {}): Promise<void> {
  await setRun(runId, { status, finishedAt: new Date(), result: patch.result ?? undefined, lastError: patch.lastError ?? undefined });
}

export async function runIsCancelled(runId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
  return !run || TERMINAL_RUN_STATUSES.includes(run.status);
}

export interface ComputerContext {
  computerId: string;
  name: string;
  organizationId: string;
  status: string;
  provider: VirtualizationProvider;
  instanceId: string;
  cdpPort: number;
  action: ActionContext;
}

/** Resolves the live desktop target for a computer. Throws ProviderError when it is unusable. */
export async function computerContext(computerId: string, config: Config): Promise<ComputerContext> {
  const computer = await prisma.computer.findFirst({ where: { id: computerId, deletedAt: null }, include: { host: { include: { credential: true } } } });
  if (!computer) throw new ProviderError("RESOURCE_NOT_FOUND", "AI Computer was not found");
  if (!computer.host || !computer.providerInstanceId) throw new ProviderError("PROVIDER_UNAVAILABLE", "AI Computer has no provider instance");
  if (computer.status !== "RUNNING") throw new ProviderError("OPERATION_FAILED", `The AI Computer is ${computer.status}; start it before running agent work`);
  const provider = providerFor(computer.host, config);
  if (!provider.getDesktopEndpoint) throw new ProviderError("CAPABILITY_UNSUPPORTED", "This provider has no desktop endpoint");
  const endpoint = await provider.getDesktopEndpoint(computer.providerInstanceId);
  if (!endpoint) throw new ProviderError("PROVIDER_UNAVAILABLE", "The desktop stream endpoint is unavailable");
  return {
    computerId: computer.id, name: computer.name, organizationId: computer.organizationId, status: computer.status,
    provider, instanceId: computer.providerInstanceId, cdpPort: endpoint.cdpPort,
    action: { provider, instanceId: computer.providerInstanceId, cdpPort: endpoint.cdpPort }
  };
}

export interface Observation {
  computerId: string; agentRunId: string | null; runStatus: AgentRunStatus | null; controller: string;
  observedAt: string; desktop: { width: number | null; height: number | null };
  browser: { browser: string | null; pages: { url: string; title: string }[] } | null;
  screenshot: { mimeType: string; bytes: number; capturedAt: string; imageBase64: string } | null;
}

/** screenshot → geometry → visible browser tabs: the observation half of the loop. */
export async function observeComputer(computerId: string, config: Config, options: { includeImage?: boolean; agentRunId?: string | null } = {}): Promise<Observation> {
  const context = await computerContext(computerId, config);
  const [geometry, browser] = await Promise.all([
    displayGeometry(context.provider, context.instanceId),
    browserState(context.provider, context.instanceId, context.cdpPort)
  ]);
  const screenshot = options.includeImage === false ? null : await captureScreenshot(context.provider, context.instanceId);
  return {
    computerId, agentRunId: options.agentRunId ?? null,
    runStatus: options.agentRunId ? (await prisma.agentRun.findUnique({ where: { id: options.agentRunId }, select: { status: true } }))?.status ?? null : null,
    controller: "agent", observedAt: new Date().toISOString(),
    desktop: { width: geometry?.width ?? null, height: geometry?.height ?? null },
    browser: browser ? { browser: browser.browser, pages: browser.pages.map(page => ({ url: page.url, title: page.title })) } : null,
    screenshot: screenshot ? { mimeType: screenshot.mimeType, bytes: screenshot.bytes, capturedAt: screenshot.capturedAt, imageBase64: screenshot.base64 } : null
  };
}

// ---------------------------------------------------------------------------------------------
// Recipes: the plan an agent follows. Each step is a real desktop or browser action whose result
// is streamed to the viewer, so a human can watch the plan execute line by line.
// ---------------------------------------------------------------------------------------------

export interface RunBag {
  context: ActionContext;
  computerId: string;
  notes: Record<string, unknown>;
  needsHuman: string | null;
}

export interface StepOutcome { ok: boolean; message: string; detail?: Record<string, unknown>; }
export interface RecipeStep { label: string; run: (bag: RunBag) => Promise<StepOutcome>; }
export interface AgentRecipe { id: string; title: string; description: string; build: (input: { instruction: string }) => RecipeStep[]; }

const actionStep = (label: string, action: AgentAction): RecipeStep => ({
  label,
  run: async bag => {
    const result = await performAction(bag.context, action);
    return { ok: result.ok, message: result.message, detail: result.detail };
  }
});

const REPOSITORY_BLOCKLIST = new Set(["login", "signup", "features", "enterprise", "pricing", "settings", "notifications", "explore", "topics", "trending", "collections", "sponsors", "about", "security", "apps", "marketplace", "orgs", "new", "search"]);

const REPOSITORY_EXTRACTOR = `(()=>{
  const blocked=${JSON.stringify([...REPOSITORY_BLOCKLIST])};
  const hrefs=[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')||'');
  const repos=[...new Set(hrefs.filter(h=>/^\\/[^\\/?#]+\\/[^\\/?#]+$/.test(h)).map(h=>h.split('?')[0]).filter(h=>!blocked.includes(h.split('/')[1])))];
  return JSON.stringify({url:location.href,title:document.title,repositories:repos.slice(0,5),needsLogin:Boolean(document.querySelector('input[type=password]'))});
})()`;

interface PageProbe { url: string; title: string; repositories: string[]; needsLogin: boolean; }

async function probePage(bag: RunBag): Promise<PageProbe> {
  const raw = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, REPOSITORY_EXTRACTOR);
  let parsed: PageProbe = { url: "", title: "", repositories: [], needsLogin: false };
  if (typeof raw === "string") { try { parsed = { ...parsed, ...(JSON.parse(raw) as Partial<PageProbe>) }; } catch { /* page not readable */ } }
  else if (raw && typeof raw === "object") parsed = { ...parsed, ...(raw as Partial<PageProbe>) };
  return parsed;
}

function githubRepositoryRecipe(): RecipeStep[] {
  const found = { repository: "", title: "", repositories: 0 };
  return [
    actionStep("Opening Chromium", { type: "focus_browser" }),
    actionStep("Navigating to github.com", { type: "browser_navigate", url: "https://github.com" }),
    actionStep("Looking at the GitHub home page", { type: "screenshot" }),
    actionStep("Searching GitHub for xdigitexai", { type: "browser_navigate", url: "https://github.com/search?q=xdigitexai&type=repositories" }),
    {
      label: "Reading the search results",
      run: async bag => {
        const page = await probePage(bag);
        if (page.needsLogin) { bag.needsHuman = "GitHub asked for a sign-in"; return { ok: true, message: "GitHub is asking for a human sign-in", detail: { url: page.url } }; }
        const first = page.repositories.at(0);
        if (first) { found.repository = first; found.repositories = page.repositories.length; return { ok: true, message: `Found ${page.repositories.length} repositories; first is ${first}`, detail: { repositories: page.repositories } }; }
        return { ok: true, message: "The search page returned no repository links; falling back to the organisation page", detail: { url: page.url } };
      }
    },
    actionStep("Opening the organisation page as a fallback", { type: "browser_navigate", url: "https://github.com/xdigitexai" }),
    {
      label: "Choosing a repository to open",
      run: async bag => {
        if (found.repository) return { ok: true, message: `Repository selected: ${found.repository}`, detail: { repository: found.repository } };
        const page = await probePage(bag);
        const first = page.repositories.at(0);
        if (!first) return { ok: false, message: "No public repository could be found for xdigitexai", detail: { url: page.url, title: page.title } };
        found.repository = first;
        found.repositories = page.repositories.length;
        return { ok: true, message: `Repository selected: ${first}`, detail: { repositories: page.repositories } };
      }
    },
    {
      label: "Opening the repository page",
      run: async bag => {
        if (!found.repository) return { ok: false, message: "No repository was selected", detail: {} };
        const result = await performAction(bag.context, { type: "browser_navigate", url: `https://github.com${found.repository}` });
        return { ok: result.ok, message: `Opened ${found.repository}`, detail: result.detail };
      }
    },
    {
      label: "Inspecting the repository page",
      run: async bag => {
        const value = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, `(()=>{const t=document.querySelector('strong[itemprop="name"] a, h1')?.innerText?.trim()||document.title;const d=(document.querySelector('p.f4.my-3, [itemprop="description"]')?.innerText||'').trim().slice(0,200);const stars=(document.querySelector('#repo-stars-counter-star')?.innerText||'0').trim();const lang=(document.querySelector('[data-ga-click*="language"], .BorderGrid-row .color-fg-default')?.innerText||'').trim().slice(0,40);return JSON.stringify({title:t,description:d,stars,language:lang,url:location.href});})()`);
        found.title = typeof value === "string" ? value : JSON.stringify(value ?? "");
        return { ok: Boolean(value), message: `Inspected the repository page: ${found.title.slice(0, 180)}`, detail: { inspection: found.title } };
      }
    },
    actionStep("Captured the repository page", { type: "screenshot" }),
    actionStep("Opening a terminal", { type: "open_terminal" }),
    {
      label: "Running command…",
      run: async bag => {
        if (!found.repository) return { ok: false, message: "No repository name is available to write", detail: {} };
        const command = `mkdir -p ~/Desktop && printf '%s\\n' '${found.repository.replace(/'/g, "")}' > ~/Desktop/agent-live-test.txt`;
        const result = await performAction(bag.context, { type: "visible_command", command });
        return { ok: result.ok, message: `Created ~/Desktop/agent-live-test.txt containing ${found.repository}`, detail: result.detail };
      }
    },
    {
      label: "Verifying the file",
      run: async bag => {
        const result = await performAction(bag.context, { type: "terminal_command", command: "cat /home/agent/Desktop/agent-live-test.txt && ls -l /home/agent/Desktop/agent-live-test.txt" });
        const stdout = String(result.detail.stdout ?? "").trim();
        const expected = found.repository.replace(/^\//, "");
        const ok = result.ok && stdout.includes(expected);
        bag.notes.fileContent = stdout;
        bag.notes.repository = found.repository;
        return { ok, message: ok ? `Verified the file contains ${expected}` : "The file did not contain the repository name", detail: { stdout } };
      }
    },
    actionStep("Captured the finished desktop", { type: "screenshot" })
  ];
}

function webSearchDownloadRecipe(): RecipeStep[] {
  const download = { url: "https://example.com/index.html", query: "xdigitex agent computer" };
  return [
    actionStep("Opening Chromium", { type: "focus_browser" }),
    {
      label: `Searching the web for ${download.query}`,
      run: async bag => {
        const result = await performAction(bag.context, { type: "browser_navigate", url: `https://duckduckgo.com/?q=${encodeURIComponent(download.query)}` });
        return { ok: result.ok, message: `Searched the web for ${download.query}`, detail: result.detail };
      }
    },
    actionStep("Looking at the search results", { type: "screenshot" }),
    {
      label: "Reading the search results",
      run: async bag => {
        const value = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, "JSON.stringify({url:location.href,title:document.title,links:[...document.querySelectorAll('a[data-testid=result-title-a]')].slice(0,3).map(a=>a.innerText.trim())})");
        return { ok: Boolean(value), message: "Read the visible search results", detail: { results: value } };
      }
    },
    actionStep("Opening a terminal", { type: "open_terminal" }),
    {
      label: "Downloading a file",
      run: async bag => {
        const result = await performAction(bag.context, { type: "visible_command", command: `mkdir -p ~/Downloads && curl -fsSL -o ~/Downloads/agent-download.txt ${download.url}` });
        return { ok: result.ok, message: `Downloaded ${download.url} into ~/Downloads`, detail: result.detail };
      }
    },
    {
      label: "Verifying the download",
      run: async bag => {
        const result = await performAction(bag.context, { type: "terminal_command", command: "wc -c /home/agent/Downloads/agent-download.txt && head -c 80 /home/agent/Downloads/agent-download.txt" });
        bag.notes.download = String(result.detail.stdout ?? "").trim();
        return { ok: result.ok, message: result.ok ? "Verified the downloaded file" : "The download could not be verified", detail: { stdout: bag.notes.download } };
      }
    },
    actionStep("Captured the finished desktop", { type: "screenshot" })
  ];
}

function dashboardRecipe(instruction: string): RecipeStep[] {
  const target = firstUrl(instruction) ?? "https://example.com";
  return [
    actionStep("Opening Chromium", { type: "focus_browser" }),
    actionStep(`Navigating to ${target.replace(/^https?:\/\//, "").split("/")[0]}`, { type: "browser_navigate", url: target }),
    actionStep("Looking at the dashboard", { type: "screenshot" }),
    {
      label: "Inspecting the configuration surface",
      run: async bag => {
        const value = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, "JSON.stringify({url:location.href,title:document.title,headings:[...document.querySelectorAll('h1,h2,h3')].slice(0,6).map(h=>h.innerText.trim()).filter(Boolean),fields:[...document.querySelectorAll('input,select,textarea')].slice(0,12).map(f=>({name:f.getAttribute('name')||f.id||f.type,type:f.type,value:String(f.value||'').slice(0,40)}))})");
        bag.notes.inspection = value;
        return { ok: Boolean(value), message: "Inspected the dashboard configuration surface", detail: { inspection: value } };
      }
    },
    {
      label: "Reporting the configuration findings",
      run: async bag => ({ ok: true, message: `Reported findings for ${target}. Applying a configuration change needs a site-specific recipe.`, detail: { inspection: bag.notes.inspection, target } })
    },
    actionStep("Captured the finished desktop", { type: "screenshot" })
  ];
}

function genericRecipe(instruction: string): RecipeStep[] {
  const target = firstUrl(instruction) ?? "https://example.com";
  return [
    actionStep("Opening Chromium", { type: "focus_browser" }),
    actionStep(`Navigating to ${target.replace(/^https?:\/\//, "").split("/")[0]}`, { type: "browser_navigate", url: target }),
    actionStep("Looking at the page", { type: "screenshot" }),
    {
      label: "Reading the page",
      run: async bag => {
        const value = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, "JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').trim().slice(0,400)})");
        bag.notes.page = value;
        return { ok: Boolean(value), message: "Read the visible page", detail: { page: value } };
      }
    },
    actionStep("Captured the finished desktop", { type: "screenshot" })
  ];
}

// A page that needs a password is the one thing an agent must never handle itself: it pauses,
// hands the keyboard to a human on the live desktop, and picks the work up again afterwards.
function humanSignInRecipe(instruction: string): RecipeStep[] {
  const target = firstUrl(instruction) ?? "https://github.com/login";
  const probe = "JSON.stringify({url:location.href,title:document.title,needsLogin:Boolean(document.querySelector('input[type=password]'))})";
  return [
    actionStep("Opening Chromium", { type: "focus_browser" }),
    actionStep(`Navigating to ${describeHost(target)}`, { type: "browser_navigate", url: target }),
    actionStep("Looking at the page", { type: "screenshot" }),
    {
      label: "Checking whether a human sign-in is required",
      run: async bag => {
        const raw = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, probe);
        const page = typeof raw === "string" ? (JSON.parse(raw) as PageProbe) : (raw as PageProbe | null);
        if (page?.needsLogin) {
          bag.needsHuman = "A password field is on screen, so a human has to sign in";
          return { ok: true, message: "This page needs a human sign-in — asking the operator to take control", detail: { url: page.url, title: page.title } };
        }
        return { ok: true, message: "No sign-in was required", detail: { url: page?.url ?? "", title: page?.title ?? "" } };
      }
    },
    {
      label: "Re-checking the page after the human released control",
      run: async bag => {
        const raw = await browserEvaluate(bag.context.provider, bag.context.instanceId, bag.context.cdpPort, probe);
        const page = typeof raw === "string" ? (JSON.parse(raw) as PageProbe) : (raw as PageProbe | null);
        bag.notes.afterHuman = page;
        return { ok: true, message: page?.needsLogin ? "The sign-in form is still on screen" : "The sign-in form is gone — continuing after the human", detail: { url: page?.url ?? "", title: page?.title ?? "" } };
      }
    },
    actionStep("Captured the page after human control", { type: "screenshot" })
  ];
}

function describeHost(value: string): string {
  try { return new URL(value).hostname; } catch { return value.slice(0, 80); }
}

export function firstUrl(input: string | null | undefined): string | null {
  const match = input?.match(/https?:\/\/[^\s"'<>]+/);
  return match ? match[0] : null;
}

export const recipes: AgentRecipe[] = [
  { id: "github-repository-check", title: "Open GitHub and check my repository", description: "Opens the visible Chromium, searches GitHub for xdigitexai, opens the first public repository, inspects it, and writes its name to ~/Desktop/agent-live-test.txt in a visible terminal.", build: () => githubRepositoryRecipe() },
  { id: "web-search-download", title: "Search the web and download a file", description: "Searches the web in the visible Chromium, then downloads a benign file into ~/Downloads from a visible terminal.", build: () => webSearchDownloadRecipe() },
  { id: "dashboard-configuration-check", title: "Open my dashboard and fix the configuration", description: "Opens the dashboard URL named in the task in the visible Chromium, inspects its configuration surface and reports findings. A configuration change needs a site-specific recipe.", build: input => dashboardRecipe(input.instruction) },
  { id: "wait-for-human-signin", title: "Open a sign-in page and wait for a human", description: "Opens the sign-in URL named in the task (github.com/login by default) in the visible Chromium, sets WAITING_FOR_HUMAN when it sees a password field, waits for the operator to sign in and release control, then re-screenshots and continues.", build: input => humanSignInRecipe(input.instruction) },
  { id: "generic-browse", title: "Open a page and report what is there", description: "Opens the first URL mentioned in the task in the visible Chromium and reports the page title and visible text.", build: input => genericRecipe(input.instruction) }
];

export function recipeTitle(recipeId: string | null | undefined): string | null {
  return recipes.find(recipe => recipe.id === recipeId)?.title ?? null;
}

export function chooseRecipe(instruction: string | null | undefined, requested?: string | null): AgentRecipe {
  const explicit = recipes.find(recipe => recipe.id === requested);
  if (explicit) return explicit;
  const text = (instruction ?? "").toLowerCase();
  if (/github/.test(text)) return recipes[0] as AgentRecipe;
  if (/download|search the web|web search/.test(text)) return recipes[1] as AgentRecipe;
  if (/sign in|signin|log ?in|password/.test(text)) return recipes[3] as AgentRecipe;
  if (/dashboard|configuration|config/.test(text)) return recipes[2] as AgentRecipe;
  return recipes[4] as AgentRecipe;
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

export interface ExecutorDeps { config: Config; control: ControlLock; activity: ActivityHub; }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function parkUntilHumanReleases(deps: ExecutorDeps, runId: string, computerId: string, reason: string, runOrganizationId: string): Promise<boolean> {
  await setRun(runId, { status: "WAITING_FOR_HUMAN", phase: reason });
  await deps.activity.tryRecord(prisma, { computerId, organizationId: runOrganizationId, agentRunId: runId, kind: "agent.waiting_for_human", message: "Agent paused — login required", severity: "warn", metadata: { reason } });
  let sawHuman = (await deps.control.get(computerId)).controller === "human";
  let released = false;
  const dispose = await deps.activity.subscribe(computerId, event => {
    if (event.kind === "human.took_control") sawHuman = true;
    if (event.kind === "human.control_released") released = true;
  });
  const deadline = Date.now() + WAIT_FOR_HUMAN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (await runIsCancelled(runId)) return false;
      if (released || (sawHuman && (await deps.control.get(computerId)).controller === "agent")) {
        await deps.activity.tryRecord(prisma, { computerId, organizationId: runOrganizationId, agentRunId: runId, kind: "agent.observing_again", message: "Agent resumed and is looking at the screen again", severity: "info" });
        return true;
      }
      await sleep(1500);
    }
    return false;
  } finally { await dispose(); }
}

async function checkHumanHold(deps: ExecutorDeps, runId: string, computerId: string, organizationId: string): Promise<boolean> {
  let announced = false;
  const deadline = Date.now() + WAIT_FOR_HUMAN_TIMEOUT_MS;
  while ((await deps.control.get(computerId)).controller === "human") {
    if (await runIsCancelled(runId)) return false;
    if (!announced) {
      announced = true;
      await deps.activity.tryRecord(prisma, { computerId, organizationId, agentRunId: runId, kind: "agent.paused", message: "Agent paused while a human holds control", severity: "warn" });
    }
    if (Date.now() > deadline) return false;
    await sleep(1500);
  }
  if (announced) await deps.activity.tryRecord(prisma, { computerId, organizationId, agentRunId: runId, kind: "agent.resumed", message: "Human released control — agent resumed", severity: "info" });
  return true;
}

/** Runs one agent task to completion, streaming every step to the live activity panel. */
export async function executeRun(runId: string, deps: ExecutorDeps): Promise<{ status: AgentRunStatus; result?: string; lastError?: string }> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) return { status: "FAILED", lastError: "The agent run no longer exists" };
  if (TERMINAL_RUN_STATUSES.includes(run.status)) return { status: run.status };

  const computerId = run.computerId;
  const organizationId = run.organizationId;
  const say = (kind: string, message: string, severity: "info" | "success" | "warn" | "error" = "info", metadata?: Record<string, unknown>) =>
    deps.activity.tryRecord(prisma, { computerId, organizationId, agentRunId: runId, kind, message, severity, metadata });

  try {
    const context = await computerContext(computerId, deps.config);
    const recipe = chooseRecipe(run.instruction, run.recipe);
    await setRun(runId, { status: "ACTING", phase: `${recipe.title}` });
    if (!(await checkHumanHold(deps, runId, computerId, organizationId))) {
      await finishRun(runId, "DETACHED");
      return { status: "DETACHED" };
    }

    const bag: RunBag = { context: context.action, computerId, notes: {}, needsHuman: null };
    const steps = recipe.build({ instruction: run.instruction ?? "" });
    for (const step of steps) {
      if (await runIsCancelled(runId)) { await say("agent.detached", "Agent detached before finishing"); return { status: "DETACHED" }; }
      if (!(await checkHumanHold(deps, runId, computerId, organizationId))) { await finishRun(runId, "DETACHED"); return { status: "DETACHED" }; }
      await setRun(runId, { status: "ACTING", phase: step.label });
      await say("agent.step", step.label);
      const outcome = await step.run(bag);
      if (outcome.ok) await say("agent.step.completed", outcome.message, "success", safeActivityMetadata(outcome.detail));
      else {
        await say("agent.step.failed", outcome.message, "error", safeActivityMetadata(outcome.detail));
        await finishRun(runId, "FAILED", { lastError: outcome.message });
        await say("agent.detached", `Agent detached — task failed: ${outcome.message}`, "error");
        return { status: "FAILED", lastError: outcome.message };
      }
      if (bag.needsHuman) {
        const releasedOk = await parkUntilHumanReleases(deps, runId, computerId, bag.needsHuman, organizationId);
        if (!releasedOk) {
          const cancelled = await runIsCancelled(runId);
          if (!cancelled) await finishRun(runId, "FAILED", { lastError: "Timed out waiting for a human" });
          await say("agent.detached", cancelled ? "Agent detached while waiting for a human" : "Agent gave up waiting for a human", "warn");
          return { status: cancelled ? "DETACHED" : "FAILED" };
        }
        bag.needsHuman = null;
        await setRun(runId, { status: "OBSERVING", phase: "Re-observing after human control" });
        await say("agent.step", "Taking a fresh screenshot after the human released control");
        const refreshed = await performAction(bag.context, { type: "screenshot" });
        await say("agent.step.completed", refreshed.message, refreshed.ok ? "success" : "warn", refreshed.detail);
      }
    }

    const summary = summarize(bag, run);
    await finishRun(runId, "COMPLETED", { result: summary });
    await say("agent.completed", `Task complete: ${summary}`, "success");
    await say("agent.detached", "Agent detached — the desktop and the computer stay running");
    return { status: "COMPLETED", result: summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent run failed";
    await finishRun(runId, "FAILED", { lastError: message.slice(0, 500) });
    await say("agent.detached", `Agent detached — task failed: ${message}`, "error");
    return { status: "FAILED", lastError: message };
  }
}

function summarize(bag: RunBag, run: AgentRun): string {
  const repository = bag.notes.repository;
  if (typeof repository === "string" && repository) return `${run.title}: ${repository}`;
  const visible = Object.keys(bag.notes).filter(key => key !== "inspection");
  return visible.length ? `${run.title} (${visible.join(", ")})` : run.title;
}

export interface ControllerSnapshot {
  computerId: string;
  controller: "agent" | "human";
  holderId: string | null;
  holderEmail: string | null;
  since: string | null;
  expiresInSeconds: number | null;
  session: { attached: boolean; agentRunId: string | null; agentName: string | null; status: AgentRunStatus | null; phase: string | null; waitingForHuman: boolean; title: string | null };
}

export async function controllerSnapshot(computerId: string, control: ControlLock): Promise<ControllerSnapshot> {
  const [state, run] = await Promise.all([control.get(computerId), activeRunFor(computerId)]);
  return {
    computerId,
    controller: state.controller,
    holderId: state.holderId,
    holderEmail: state.holderEmail,
    since: state.since,
    expiresInSeconds: state.expiresInSeconds,
    session: {
      attached: Boolean(run),
      agentRunId: run?.id ?? null,
      agentName: run?.agentName ?? null,
      status: run?.status ?? null,
      phase: run?.phase ?? null,
      waitingForHuman: run?.status === "WAITING_FOR_HUMAN",
      title: run?.title ?? null
    }
  };
}
