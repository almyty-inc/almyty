import { Controller } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@Controller('v1')
@ApiTags('OpenAI Compatible')
export class AgentOpenAICompatController {
  // Phase 4: POST /v1/chat/completions
  // Phase 4: GET /v1/models
}
