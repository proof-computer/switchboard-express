# Switchboard Express Adapter

Express helpers for Acurast jobs deployed through Switchboard.

This package is public for GitHub installs during the private beta. It is not
published on npmjs.com yet.

## Install

```sh
npm install github:proof-computer/switchboard-express#v0.1.2 express
npm install -D typescript tsx @types/node @types/express
```

Use `#main` only when intentionally testing unreleased changes. npmjs.com
publishing is prepared but not active yet.

## App

```ts
import express from "express";
import { serveSwitchboardExpress } from "@proofcomputer/switchboard-express";

const app = express();

app.get("/", (_request, response) => {
  response.type("html").send("<h1>Switchboard Express</h1><p>ok</p>");
});

void serveSwitchboardExpress(app).catch((error) => {
  console.error(error);
  process.exit(1);
});
```

The adapter mounts Switchboard health, status, and challenge endpoints and
starts the server with the job-owned TLS/runtime config supplied at deploy
time.
