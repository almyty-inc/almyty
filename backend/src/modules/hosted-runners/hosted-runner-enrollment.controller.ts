import { Body, Controller, Headers, HttpCode, Post, Request, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';

import { RunnerCredentialGuard } from '../runner/runner-credential';
import { EnrollmentService } from './enrollment.service';
import { EnrollRunnerDto } from './dto/environment.dto';
import { HostedModelTokenService } from './hosted-model-token.service';
import { presentedToken } from './hosted-model-token.contract';

/**
 * Where a hosted runner pod gets and renews its credentials. Enrollment
 * takes no login: the single-use token in the body is the proof, and a
 * token that is unknown, used or expired gets one 401 for all three.
 * Renewal takes the current runner credential and nothing else. The pod
 * model token is renewed with itself, while it is current and its pod
 * runs.
 */
@Controller('runners')
export class HostedRunnerEnrollmentController {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly modelTokens: HostedModelTokenService,
  ) {}

  @Post('enroll')
  @HttpCode(200)
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async enroll(@Body() body: EnrollRunnerDto) {
    const result = await this.enrollment.enroll({ token: body.token, runtimeInfo: body.runtimeInfo as any, config: body.config as any });
    return { success: true, data: result };
  }

  @Post('hosted/credential')
  @HttpCode(200)
  @UseGuards(RunnerCredentialGuard)
  async renew(@Request() req: any) {
    return { success: true, data: await this.enrollment.renew(req.runnerCredential) };
  }

  /** A fresh pod model token for the current one, which stops working at once. */
  @Post('hosted/model-token')
  @HttpCode(200)
  async renewModelToken(@Headers('authorization') authorization?: string) {
    return { success: true, data: await this.modelTokens.renew(presentedToken(authorization)) };
  }
}
