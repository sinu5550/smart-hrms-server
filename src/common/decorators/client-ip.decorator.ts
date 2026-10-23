import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { Request } from "express";

export function resolveClientIp(req: Request): string {
  const xForwardedFor = req.headers["x-forwarded-for"];
  let rawIp = "";

  if (typeof xForwardedFor === "string") {
    rawIp = xForwardedFor.split(",")[0].trim();
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    rawIp = xForwardedFor[0].trim();
  } else {
    rawIp = req.ip || req.socket.remoteAddress || "";
  }

  if (rawIp.startsWith("::ffff:")) {
    rawIp = rawIp.slice(7);
  }

  return rawIp === "::1" ? "127.0.0.1" : rawIp;
}

export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return resolveClientIp(request);
  },
);
