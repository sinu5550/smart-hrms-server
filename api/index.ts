import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import express, { Express } from "express";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/main";

let server: Express;

async function bootstrapServerless(): Promise<Express> {
  const expressApp = express();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    new (require("@nestjs/platform-express").ExpressAdapter)(expressApp)
  );
  configureApp(app);
  await app.init();
  return expressApp;
}

export default async function handler(req: any, res: any) {
  if (!server) {
    server = await bootstrapServerless();
  }
  server(req, res);
}
