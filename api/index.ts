import "reflect-metadata";
import type { Request, Response } from "express";

let cachedHandler: any = null;

export default async function handler(req: Request, res: Response) {
  try {
    if (!cachedHandler) {
      // Dynamically import ESM NestJS modules inside CommonJS serverless function
      const { NestFactory } = await import("@nestjs/core");
      const { ExpressAdapter } = await import("@nestjs/platform-express");
      const express = (await import("express")).default;
      const { AppModule } = await import("../src/app.module");
      const { configureApp } = await import("../src/main");

      const expressApp = express();
      const adapter = new ExpressAdapter(expressApp);
      const app = await NestFactory.create(AppModule, adapter, {
        logger: ["error", "warn", "log"],
      });

      configureApp(app as any);
      await app.init();
      cachedHandler = expressApp;
    }

    return cachedHandler(req, res);
  } catch (error: any) {
    console.error("Vercel Serverless Invocation Crash:", error);
    return res.status(500).json({
      statusCode: 500,
      message: "Vercel Serverless Dynamic Initialization Error",
      error: error?.message || String(error),
      stack: error?.stack,
    });
  }
}
