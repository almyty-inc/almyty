import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ModelCatalogService } from './model-catalog.service';
import { ListModelsQueryDto, RegisterEndpointBodyDto, RegisterModelBodyDto, SyncModelsBodyDto, UpdateModelBodyDto } from './dto/model-catalog-controller.dto';

/** Cards in, cards out. Nothing here calls a provider except the validation run, which is the point of it. */
@ApiTags('Models')
@ApiBearerAuth()
@Controller('models')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ModelCatalogController {
  constructor(private readonly catalog: ModelCatalogService) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List model cards' })
  async list(@Request() req: any, @Query(new ValidationPipe({ transform: true })) query: ListModelsQueryDto) {
    const rows = await this.catalog.list(this.orgId(req), query);
    return { success: true, data: rows.map(view) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Register a model card against a stored provider or an endpoint' })
  async register(@Request() req: any, @Body(ValidationPipe) body: RegisterModelBodyDto) {
    const card = await this.catalog.register(this.orgId(req), body, req.user?.id);
    return { success: true, data: view(card) };
  }

  @Post('register-endpoint')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Register a hand-run OpenAI-compatible endpoint as a model card' })
  async registerEndpoint(@Request() req: any, @Body(ValidationPipe) body: RegisterEndpointBodyDto) {
    const card = await this.catalog.registerEndpoint(this.orgId(req), body, req.user?.id);
    return { success: true, data: view(card) };
  }

  @Post('sync')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Import the models a stored provider lists as unvalidated cards' })
  async sync(@Request() req: any, @Body(ValidationPipe) body: SyncModelsBodyDto) {
    const result = await this.catalog.syncFromProvider(this.orgId(req), body.providerId, req.user?.id);
    return { success: true, data: { created: result.created.map(view), skipped: result.skipped } };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Model card detail' })
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: view(await this.catalog.get(this.orgId(req), id)) };
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update a card: privacy tier, region, capabilities, price override, status' })
  async update(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body(ValidationPipe) body: UpdateModelBodyDto) {
    return { success: true, data: view(await this.catalog.update(this.orgId(req), id, body, req.user?.id)) };
  }

  @Post(':id/validate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Run one real call through the card; passing makes it selectable' })
  async validate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const outcome = await this.catalog.validate(this.orgId(req), id, req.user?.id);
    return { success: outcome.passed, data: { ...outcome, model: view(outcome.model) } };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove a card' })
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.remove(this.orgId(req), id, req.user?.id);
    return { success: true };
  }
}

function view(card: any) {
  return { ...card, selectable: typeof card.isSelectable === 'function' ? card.isSelectable() : false, effectivePricing: typeof card.effectivePricing === 'function' ? card.effectivePricing() : null };
}
