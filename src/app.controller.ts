import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get()
  getHealth() {
    return {
      status: "ok",
      name: "Enterprise HRMS API",
      timestamp: new Date().toISOString(),
    };
  }

  @Get("health")
  checkHealth() {
    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
    };
  }
}
