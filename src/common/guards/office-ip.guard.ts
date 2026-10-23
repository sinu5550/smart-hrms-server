import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { PrismaService } from "../../prisma/prisma.service";
import { resolveClientIp } from "../decorators/client-ip.decorator";

@Injectable()
export class OfficeIpGuard implements CanActivate {
  private readonly logger = new Logger(OfficeIpGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const organizationId = (request as Request & { user?: { organizationId?: string | null } }).user?.organizationId;
    if (!organizationId) throw new ForbiddenException("Attendance requires an organization workspace.");
    const isBypassEnabled = this.configService.get<string>("BYPASS_IP_CHECK") === "true";
    if (isBypassEnabled) {
      return true;
    }

    const clientIp = resolveClientIp(request);

    if (!clientIp) {
      throw new ForbiddenException("Network origin undetermined.");
    }

    const network = await this.prisma.officeNetwork.findFirst({
      where: {
        organizationId,
        allowedPublicIp: clientIp,
        isActive: true,
      },
      select: { id: true, locationName: true },
    });

    if (!network) {
      this.logger.warn(`Unauthorized IP access attempt detected: ${clientIp}`);
      throw new ForbiddenException(
        `Access blocked: Attendance and break actions must occur on Office Wi-Fi. Current IP: ${clientIp}`,
      );
    }

    return true;
  }
}
