import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ModelCatalogService } from './model-catalog.service';
import { ListModelsQueryDto, RegisterEndpointBodyDto, RegisterModelBodyDto, RoutePreviewBodyDto, SyncModelsBodyDto, UpdateModelBodyDto } from './dto/model-catalog-controller.dto';
import { ModelRouterService } from './routing/model-router.service';

/** Cards in, cards out. Nothing here calls a provider except the validation run, which is the point of it. */
@ApiTags('Models')
@ApiBearerAuth()
@Controller('models')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ModelCatalogController {
  constructor(
    private readonly catalog: ModelCatalogService,
    private readonly router: ModelRouterService,
  ) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  /**
   * What a policy would choose right now, and what it would reject.
   *
   * L3 is usable with no agent: this takes a policy directly and answers
   * with the ordered candidates and every rejection with its reason. It
   * is what the policy editor previews against, and it is the honest way
   * to answer "why did it not pick that model", which was previously only
   * discoverable by running something. See docs/design/layers.md, L3.
   *
   * Nothing is called: this plans, it does not route a request.
   */
  @Post('route-preview')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Preview which models a routing policy would choose, and why the rest were rejected' })
  async routePreview(@Request() req: any, @Body(new ValidationPipe({ transform: true })) body: RoutePreviewBodyDto) {
    const plan = await this.router.preview(this.orgId(req), body ?? {}, req.user?.id ? { id: req.user.id } : undefined);
    return { success: true, data: plan };
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List models' })
  async list(@Request() req: any, @Query(new ValidationPipe({ transform: true })) query: ListModelsQueryDto) {
    const rows = await this.catalog.list(this.orgId(req), query);
    return { success: true, data: rows.map(view) };
  }

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Register a model against a stored provider or an endpoint' })
  async register(@Request() req: any, @Body(ValidationPipe) body: RegisterModelBodyDto) {
    const card = await this.catalog.register(this.orgId(req), body, req.user?.id);
    return { success: true, data: view(card) };
  }

  @Post('register-endpoint')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Register a hand-run OpenAI-compatible endpoint as a model' })
  async registerEndpoint(@Request() req: any, @Body(ValidationPipe) body: RegisterEndpointBodyDto) {
    const card = await this.catalog.registerEndpoint(this.orgId(req), body, req.user?.id);
    return { success: true, data: view(card) };
  }

  @Post('sync')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Import what a provider lists (or, with no providerId, what every active provider lists) as unvalidated cards; vanished ids go inactive' })
  async sync(@Request() req: any, @Body(ValidationPipe) body?: SyncModelsBodyDto) {
    const organizationId = this.orgId(req);
    if (body?.providerId) {
      return { success: true, data: syncView(await this.catalog.syncFromProvider(organizationId, body.providerId, req.user?.id)) };
    }
    const summary = await this.catalog.syncAll(organizationId, req.user?.id);
    return { success: true, data: { ...syncView(summary), providers: summary.providers } };
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Model detail' })
  async get(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: view(await this.catalog.get(this.orgId(req), id)) };
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update a model: privacy, region, capabilities, price override, status' })
  async update(@Request() req: any, @Param('id', ParseUUIDPipe) id: string, @Body(ValidationPipe) body: UpdateModelBodyDto) {
    return { success: true, data: view(await this.catalog.update(this.orgId(req), id, body, req.user?.id)) };
  }

  @Post(':id/validate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Run one real call through the model; passing makes it usable' })
  async validate(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    const outcome = await this.catalog.validate(this.orgId(req), id, req.user?.id);
    return { success: outcome.passed, data: { ...outcome, model: view(outcome.model) } };
  }

  @Delete(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove a model' })
  async remove(@Request() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.catalog.remove(this.orgId(req), id, req.user?.id);
    return { success: true };
  }
}

function view(card: any) {
  return { ...card, selectable: typeof card.isSelectable === 'function' ? card.isSelectable() : false, effectivePricing: typeof card.effectivePricing === 'function' ? card.effectivePricing() : null };
}

function syncView(result: { created: any[]; skipped: number; retired: any[]; reinstated: any[] }) {
  return { created: result.created.map(view), skipped: result.skipped, retired: result.retired.map(view), reinstated: result.reinstated.map(view) };
}
