import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Express } from "express";
import { AppModule } from "./app.module";

export function configureApp(app: NestExpressApplication) {
  app.set("trust proxy", true);
  app.setGlobalPrefix("api");

  const configuredOrigins = process.env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = configuredOrigins?.length
    ? configuredOrigins
    : [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
      ];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
}

// Local server runner
async function bootstrap() {
  if (!process.env.VERCEL) {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    configureApp(app);
    const port = process.env.PORT || 3000;
    await app.listen(port);
    console.log(`Enterprise HRMS Backend live on port ${port}`);
  }
}
bootstrap();
