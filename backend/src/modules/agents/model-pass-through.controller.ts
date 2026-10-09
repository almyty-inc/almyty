import { Body, Controller, Headers, HttpCode, Inject, Optional, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { HOSTED_MODEL_TOKENS, type HostedModelTokens, presentedToken } from '../hosted-runners/hosted-model-token.contract';
import { ModelPassThroughService } from './model-pass-through.service';

/**
 * The pass-through routes only coding CLIs in hosted pods use, beside the
 * agent-backed `/v1/messages` and `/v1/chat/completions` (which hand a pod
 * token to the same pass-through):
 *
 * - `POST /v1/responses`: the OpenAI Responses API, the only one Codex
 *   speaks.
 * - `POST /v1/messages/count_tokens`: Anthropic's token counter, which
 *   Claude Code calls to size its context.
 *
 * A pod model token is the only credential either takes. An API key or a
 * session is refused, so no surface that existed before reaches a model
 * without running an agent.
 */
@Controller('v1')
@ApiTags('Model pass-through (hosted pods)')
export class ModelPassThroughController {
  constructor(
    private readonly passThrough: ModelPassThroughService,
    @Optional() @Inject(HOSTED_MODEL_TOKENS) private readonly podTokens?: HostedModelTokens,
  ) {}

  @Post('responses')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a response (OpenAI Responses API), for a hosted pod model token only' })
  async responses(@Body() body: any, @Headers('authorization') auth: string, @Req() req: Request, @Res() res: Response) {
    const key = await this.podKey(res, 'openai', presentedToken(auth));
    if (key) await this.passThrough.forward(key, 'openai_responses', body, req, res);
  }

  @Post('messages/count_tokens')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Count tokens (Anthropic-compatible), for a hosted pod model token only' })
  async countTokens(
    @Body() body: any,
    @Headers('authorization') auth: string,
    @Headers('x-api-key') xApiKey: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const key = await this.podKey(res, 'anthropic', presentedToken(auth, xApiKey));
    if (key) await this.passThrough.forward(key, 'anthropic_messages', body, req, res, { countTokens: true });
  }

  /** The pod token's principal, or a 401 in the client's protocol (then null). */
  private async podKey(res: Response, shape: 'openai' | 'anthropic', token: string | null) {
    let key = null;
    let message = 'This endpoint takes a hosted pod model token only';
    try {
      key = (await this.podTokens?.authenticate(token)) ?? null;
    } catch (err) {
      if (!(err instanceof UnauthorizedException)) throw err;
      message = err.message;
    }
    if (key) return key;
    if (shape === 'anthropic') res.status(401).json({ type: 'error', error: { type: 'authentication_error', message } });
    else res.status(401).json({ error: { message, type: 'authentication_error', code: 'invalid_api_key', param: null } });
    return null;
  }
}
