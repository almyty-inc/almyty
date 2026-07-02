import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../src/modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../src/modules/auth/guards/roles.guard';
import { Roles } from '../../../src/modules/auth/decorators/roles.decorator';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/create-checkout.dto';

/**
 * Admin-only hosted-billing surface. Gated by org role (owner/admin), NOT by an
 * entitlement — this is how an org buys its entitlements. The Stripe webhook
 * lives on a separate, unauthenticated controller (signature-verified instead).
 */
@Controller('billing')
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get(':organizationId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Get billing status for an organization' })
  async getStatus(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.billingService.getBillingStatus(organizationId);
    return { success: true, data, message: 'Billing status retrieved' };
  }

  @Get(':organizationId/invoices')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'List recent invoices' })
  async listInvoices(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.billingService.listInvoices(organizationId);
    return { success: true, data, message: 'Invoices retrieved' };
  }

  @Post(':organizationId/checkout')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a Stripe checkout session' })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createCheckout(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateCheckoutDto,
  ) {
    const data = await this.billingService.createCheckoutSession(organizationId, dto);
    return { success: true, data, message: 'Checkout session created' };
  }

  @Post(':organizationId/portal')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a Stripe billing portal session' })
  async createPortal(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    const data = await this.billingService.createPortalSession(organizationId);
    return { success: true, data, message: 'Portal session created' };
  }
}
