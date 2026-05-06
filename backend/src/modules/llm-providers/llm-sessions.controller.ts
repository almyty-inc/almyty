import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

import { LlmProvidersService } from './llm-providers.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ConversationStatus } from '../../entities/conversation.entity';

class CreateSessionDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsObject()
  context?: {
    model?: string;
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    stopSequences?: string[];
    toolsEnabled?: boolean;
    availableTools?: string[];
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class UpdateSessionDto {
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsObject()
  context?: CreateSessionDto['context'];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

@Controller('llm-providers')
@ApiTags('LLM Providers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class LlmSessionsController {
  constructor(private readonly llmProvidersService: LlmProvidersService) {}

  // Session management endpoints
  @Post(':providerId/sessions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Create a new chat session' })
  @ApiResponse({ status: 201, description: 'Session created successfully' })
  async createSession(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Body(ValidationPipe) createSessionDto: CreateSessionDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.createSession(
        providerId,
        organizationId,
        req.user.id,
        createSessionDto
      );

      return {
        success: true,
        data: session,
        message: 'Session created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':providerId/sessions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get sessions for LLM provider' })
  @ApiResponse({ status: 200, description: 'Sessions retrieved successfully' })
  async getSessions(
    @Param('providerId', ParseUUIDPipe) providerId: string,
    @Query('status') status?: ConversationStatus,
    @Query('userId') userId?: string,
    @Query('page', new ValidationPipe({ transform: true })) page = 1,
    @Query('limit', new ValidationPipe({ transform: true })) limit = 20,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.llmProvidersService.getSessions(
        organizationId,
        providerId,
        userId,
        status,
        page,
        Math.min(limit, 100)
      );

      return {
        success: true,
        data: result,
        message: 'Sessions retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSIONS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get session by ID' })
  @ApiResponse({ status: 200, description: 'Session retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async getSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.getSession(sessionId, organizationId);

      return {
        success: true,
        data: session,
        message: 'Session retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_NOT_FOUND',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Put('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update session' })
  @ApiResponse({ status: 200, description: 'Session updated successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async updateSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(ValidationPipe) updateSessionDto: UpdateSessionDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const session = await this.llmProvidersService.updateSession(
        sessionId,
        organizationId,
        updateSessionDto
      );

      return {
        success: true,
        data: session,
        message: 'Session updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete('sessions/:sessionId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete session' })
  @ApiResponse({ status: 200, description: 'Session deleted successfully' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async deleteSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.llmProvidersService.deleteSession(sessionId, organizationId);

      return {
        success: true,
        message: 'Session deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SESSION_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
