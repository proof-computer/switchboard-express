import http, { type Server as HttpServer } from "node:http";
import https from "node:https";
import express, { Router as createRouter, type Application, type Request, type Router } from "express";
import {
  buildSwitchboardChallengeResult,
  createSwitchboardRuntime,
  SWITCHBOARD_CHALLENGE_PATH,
  SWITCHBOARD_STATUS_PATH,
  type SwitchboardChallengeConfig,
  type SwitchboardRuntime,
  type SwitchboardRuntimeOptions
} from "@proofcomputer/switchboard-sdk";

export interface SwitchboardExpressRouterOptions extends Partial<SwitchboardChallengeConfig> {
  runtime?: SwitchboardRuntime;
}

export interface ServeSwitchboardExpressOptions {
  runtime?: SwitchboardRuntimeOptions | SwitchboardRuntime;
  host?: string;
  port?: number;
  mountChallenge?: boolean;
  mountStatus?: boolean;
  mountHealth?: boolean;
}

export interface SwitchboardExpressServer {
  runtime: SwitchboardRuntime;
  server: HttpServer;
  url: string;
}

export function createSwitchboardRouter(options: SwitchboardExpressRouterOptions = {}): Router {
  const runtime = options.runtime ?? createSwitchboardRuntime();
  const router = createRouter();
  router.get(SWITCHBOARD_CHALLENGE_PATH, (request, response) => {
    const result = buildSwitchboardChallengeResult(challengeConfig(runtime, request, options), {
      nonce: request.query.nonce,
      path: request.path,
      userAgent: request.header("user-agent"),
      remoteAddress: request.ip
    });
    response.status(result.statusCode);
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value);
    }
    response.json(result.body);
  });
  return router;
}

export const createProofIngressRouter = createSwitchboardRouter;

export async function serveSwitchboardExpress(
  app: Application,
  options: ServeSwitchboardExpressOptions = {}
): Promise<SwitchboardExpressServer> {
  const runtime = isRuntime(options.runtime) ? options.runtime : createSwitchboardRuntime(options.runtime);
  if (options.mountChallenge !== false) {
    app.use(createSwitchboardRouter({ runtime }));
  }
  if (options.mountHealth !== false) {
    app.get("/health", (_request, response) => response.json({ ok: true }));
  }
  if (options.mountStatus !== false) {
    app.get(SWITCHBOARD_STATUS_PATH, (_request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(statusBody(runtime));
    });
    app.get("/status", (_request, response) => {
      response.setHeader("cache-control", "no-store");
      response.json(statusBody(runtime));
    });
  }

  const prepared = await runtime.prepare();
  const host = options.host ?? runtime.configValue("SWITCHBOARD_HOST") ?? runtime.configValue("PROOF_INGRESS_HOST") ?? "127.0.0.1";
  const port = options.port ?? Number(runtime.configValue("PORT") ?? "3000");
  const server = prepared.tlsOptions ? https.createServer(prepared.tlsOptions, app) : http.createServer(app);
  await listen(server, host, port);
  const protocol = prepared.tlsOptions ? "https" : "http";
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `${protocol}://${host}:${actualPort}`;
  await runtime.log("server-listening", {
    protocol,
    host,
    port: actualPort,
    certificateHostnames: prepared.certificates.map((certificate) => certificate.hostname)
  });
  await reportReadyAfterListen(runtime, server, { protocol, host, port: actualPort });
  return { runtime, server, url };
}

export const serveProofIngressExpress = serveSwitchboardExpress;

export type ProofIngressExpressRouterOptions = SwitchboardExpressRouterOptions;
export type ServeProofIngressExpressOptions = ServeSwitchboardExpressOptions;
export type ProofIngressExpressServer = SwitchboardExpressServer;

function challengeConfig(
  runtime: SwitchboardRuntime,
  request: Request,
  options: SwitchboardExpressRouterOptions
): SwitchboardChallengeConfig {
  return {
    sessionId: options.sessionId ?? (() => runtime.sessionId()),
    deploymentId: options.deploymentId ?? runtime.deploymentId,
    jobId: options.jobId ?? (() => runtime.jobId()),
    onChallenge: options.onChallenge ?? ((event) => runtime.log("challenge-hit", {
      nonceLength: event.nonce.length,
      userAgent: request.header("user-agent"),
      remoteAddress: request.ip
    }))
  };
}

function statusBody(runtime: SwitchboardRuntime): Record<string, unknown> {
  return {
    ok: true,
    sessionId: runtime.sessionId(),
    jobId: runtime.jobId(),
    deploymentId: runtime.deploymentId,
    timestamp: Math.floor(Date.now() / 1000)
  };
}

function listen(server: HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function reportReadyAfterListen(
  runtime: SwitchboardRuntime,
  server: HttpServer,
  details: { protocol: "http" | "https"; host: string; port: number }
): Promise<void> {
  try {
    await runtime.reportReady(details);
  } catch (error) {
    await runtime.log("ready-report-failed", {
      retrying: runtime.configValue("SWITCHBOARD_READY_REPORT_RETRY") !== "false",
      error: safeError(error)
    }).catch(() => undefined);
    startReadyReportRetry(runtime, server, details);
  }
}

function startReadyReportRetry(
  runtime: SwitchboardRuntime,
  server: HttpServer,
  details: { protocol: "http" | "https"; host: string; port: number }
): void {
  if (runtime.configValue("SWITCHBOARD_READY_REPORT_RETRY") === "false") {
    return;
  }
  const intervalMs = Math.max(1_000, numberConfig(runtime, "SWITCHBOARD_READY_REPORT_RETRY_MS", 10_000));
  const maxAttempts = numberConfig(runtime, "SWITCHBOARD_READY_REPORT_MAX_ATTEMPTS", 60);
  let attempts = 0;
  const timer = setInterval(() => {
    if (attempts >= maxAttempts) {
      clearInterval(timer);
      return;
    }
    attempts += 1;
    void runtime.reportReady(details)
      .then(() => {
        clearInterval(timer);
        void runtime.log("ready-report-succeeded", { attempt: attempts }).catch(() => undefined);
      })
      .catch((error) => {
        void runtime.log("ready-report-failed", {
          attempt: attempts,
          retrying: attempts < maxAttempts,
          error: safeError(error)
        }).catch(() => undefined);
      });
  }, intervalMs);
  timer.unref();
  server.once("close", () => clearInterval(timer));
}

function numberConfig(runtime: SwitchboardRuntime, name: string, fallback: number): number {
  const value = runtime.configValue(name);
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function isRuntime(value: ServeSwitchboardExpressOptions["runtime"]): value is SwitchboardRuntime {
  return Boolean(value && typeof (value as SwitchboardRuntime).prepare === "function");
}

export { express };
