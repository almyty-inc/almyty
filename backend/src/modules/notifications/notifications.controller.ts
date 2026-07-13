import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { ChannelPrefs } from './notification-types';

class UpdatePreferencesDto {
  @IsOptional()
  @IsObject()
  matrix?: Record<string, Partial<ChannelPrefs>>;
}

/**
 * User-scoped notification API (frozen contract — the frontend builds
 * against these exact shapes):
 *
 *   GET  /notifications?unreadOnly=&page=&limit=
 *     -> { success, data: { notifications: [...], total, unreadCount } }
 *   POST /notifications/:id/read        -> { success }
 *   POST /notifications/read-all        -> { success }
 *   GET  /notifications/preferences     -> { success, data: { matrix, defaults } }
 *   PUT  /notifications/preferences     -> merged { success, data: { matrix, defaults } }
 */
@Controller('notifications')
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the caller's notifications" })
  async list(
    @Request() req: any,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.notifications.list(req.user.id, {
      unreadOnly: unreadOnly === 'true' || unreadOnly === '1',
      page: page ? parseInt(page, 10) || 1 : undefined,
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
    });
    return { success: true, data };
  }

  @Get('preferences')
  @ApiOperation({ summary: "Get the caller's notification preference matrix" })
  async getPreferences(@Request() req: any) {
    const data = await this.notifications.getPreferences(req.user.id);
    return { success: true, data };
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Merge partial preference updates; returns the merged matrix' })
  async updatePreferences(@Request() req: any, @Body() body: UpdatePreferencesDto) {
    const data = await this.notifications.updatePreferences(req.user.id, body?.matrix ?? {});
    return { success: true, data };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async readAll(@Request() req: any) {
    await this.notifications.markAllRead(req.user.id);
    return { success: true };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  async read(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(req.user.id, id);
    return { success: true };
  }
}
