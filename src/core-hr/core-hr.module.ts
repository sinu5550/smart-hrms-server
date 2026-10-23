import { Module } from '@nestjs/common';
import { CoreHrController } from './core-hr.controller';
import { CoreHrService } from './core-hr.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [CoreHrController],
  providers: [CoreHrService],
  exports: [CoreHrService],
})
export class CoreHrModule {}
