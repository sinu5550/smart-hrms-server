// api/index.mjs
// Hand-authored ESM Vercel Serverless entry point.
//
// WHY .mjs and not compiled from .ts:
//   TypeScript with "module": "commonjs" converts ALL import() expressions
//   to: Promise.resolve().then(() => __importStar(require("...")))
//   This is still a synchronous require() call and cannot load pure-ESM
//   packages like @nestjs/core@12 which has "type": "module".
//   Using .mjs bypasses TypeScript compilation so import() stays as real
//   ESM dynamic import that Node.js resolves correctly.
//
// WHY import from dist/:
//   The NestJS application code (AppModule, controllers, services, etc.)
//   is compiled to CommonJS by `nest build`. ESM can import CJS modules
//   without problems — the reverse (CJS requiring ESM) is what fails.

import "reflect-metadata";

let cachedHandler = null;

export default async function handler(req, res) {
  try {
    if (!cachedHandler) {
      const [
        { NestFactory },
        { ExpressAdapter },
        { default: express },
        { AppModule },
      ] = await Promise.all([
        import("@nestjs/core"),
        import("@nestjs/platform-express"),
        import("express"),
        import("../dist/src/app.module.js"),
      ]);

      const expressApp = express();
      const adapter = new ExpressAdapter(expressApp);
      const app = await NestFactory.create(AppModule, adapter, {
        logger: ["error", "warn", "log"],
      });

      // Configure inline — do NOT import dist/src/main.js because it calls
      // require("@nestjs/common") at top-level, which fails on an ESM package.
      app.set("trust proxy", true);
      app.setGlobalPrefix("api");

      const configuredOrigins = process.env.ALLOWED_ORIGINS
        ?.split(",")
        .map((o) => o.trim())
        .filter(Boolean);
      const allowedOrigins = configuredOrigins?.length
        ? configuredOrigins
        : [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "http://127.0.0.1:3001",
          ];

      const { ValidationPipe } = await import("@nestjs/common");

      app.enableCors({ origin: allowedOrigins, credentials: true });
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          transform: true,
          forbidNonWhitelisted: true,
          transformOptions: { enableImplicitConversion: true },
        }),
      );

      await app.init();
      cachedHandler = expressApp;
    }

    return cachedHandler(req, res);
  } catch (error) {
    console.error("[Vercel] NestJS bootstrap failed:", error);
    res.status(500).json({
      statusCode: 500,
      message: "Server initialization failed",
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}
