import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  UsePipes,
  ValidationPipe,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RunnerService, RegisterRunnerInput } from './runner.service';
import { RegisterRunnerDto } from './dto/register-runner.dto';

@Controller('runners')
@UseGuards(JwtAuthGuard)
export class RunnerController {
  constructor(private readonly service: RunnerService) {}

  @Post('register')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async register(@Request() req: any, @Body() body: RegisterRunnerDto) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const result = await this.service.register(body, ownerUserId, organizationId);
    return {
      success: true,
      data: {
        runner: result.runner,
        effectiveConfig: result.effectiveConfig,
      },
    };
  }

  @Get()
  async list(@Request() req: any) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const data = await this.service.listForOwner(ownerUserId, organizationId);
    return { success: true, data };
  }

  @Get(':id')
  async getOne(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    const data = await this.service.getOne(id, ownerUserId, organizationId);
    return { success: true, data };
  }

  @Delete(':id')
  async unregister(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const ownerUserId = req.user?.id;
    const organizationId = req.user?.currentOrganizationId;
    if (!ownerUserId || !organizationId) {
      throw new HttpException('Organization context required', HttpStatus.BAD_REQUEST);
    }
    await this.service.unregister(id, ownerUserId, organizationId);
    return { success: true };
  }
}
