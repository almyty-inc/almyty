import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLog } from '../../entities/audit-log.entity';
import { User } from '../../entities/user.entity';
import { AuditLogService } from './audit-log.service';
import { AuditLogController } from './audit-log.controller';

@Global() // Make available everywhere without importing
@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, User])],
  providers: [AuditLogService],
  controllers: [AuditLogController],
  exports: [AuditLogService],
})
export class AuditLogModule {}
