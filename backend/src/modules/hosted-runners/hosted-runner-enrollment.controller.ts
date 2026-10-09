import { Body, Controller, HttpCode, Post, Request, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';

import { RunnerCredentialGuard } from '../runner/runner-credential';
import { EnrollmentService } from './enrollment.service';
import { EnrollRunnerDto } from './dto/environment.dto';

/**
 * Where a hosted runner pod gets and renews its credential. Enrollment
 * takes no login: the single-use token in the body is the proof, and a
 * token that is unknown, used or expired gets one 401 for all three.
 * Renewal takes the current runner credential and nothing else.
 */
@Controller('runners')
export class HostedRunnerEnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

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
}
