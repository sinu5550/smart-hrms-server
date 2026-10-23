import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express, { Express, Request, Response } from "express";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/main";

let cachedServer: Express;

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
      cachedServer = await bootstrapServer();
    }
    return cachedServer(req, res);
  } catch (error: any) {
    console.error("Vercel Function Invocation Error:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Server initialization failed",
      error: error?.message || String(error),
      stack: process.env.NODE_ENV !== "production" ? error?.stack : undefined,
    });
  }
}
