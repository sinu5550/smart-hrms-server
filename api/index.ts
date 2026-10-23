import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express, { Express, Request, Response } from "express";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/main";

let cachedServer: Express | null = null;
let initPromise: Promise<Express> | null = null;

async function bootstrapServer(): Promise<Express> {
  const expressApp = express();
  const adapter = new ExpressAdapter(expressApp);
  const app = await NestFactory.create(AppModule, adapter, {
    logger: ["error", "warn", "log"],
  });

  configureApp(app as any);
  await app.init();
  return expressApp;
}

export default async function handler(req: Request, res: Response) {
  try {
    if (!cachedServer) {
      if (!initPromise) {
        initPromise = bootstrapServer();
      }
      cachedServer = await initPromise;
    }
    return cachedServer(req, res);
  } catch (error: any) {
    console.error("Vercel Serverless Function Init Error:", error);
    return res.status(500).json({
      statusCode: 500,
      message: "Vercel Serverless Function Init Error",
      error: error?.message || String(error),
      stack: error?.stack,
    });
  }
}
