import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/** The optional LLM distiller: its own provider and model. */
export class PromoteRunDistillDto {
  @ApiProperty({ description: 'LLM provider to distil the run with' })
  @IsUUID()
  providerId: string;

  @ApiPropertyOptional({ description: 'Model id; the provider default when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  model?: string;
}

/**
 * POST /promoted-skills.
 *
 * The body used to be the inline intersection `{ runId: string } &
 * PromoteRunDto`. Both halves erase at runtime, so Nest saw `Object` and
 * the global ValidationPipe skipped the parameter: `runId` was checked
 * by a hand-written `if (!body?.runId)` and nothing else was checked at
 * all -- `distill.providerId` reached the provider lookup unvalidated,
 * and the app-wide whitelist did not apply.
 */
export class PromoteRunBodyDto {
  @ApiProperty({ description: 'The completed agent run to promote' })
  @IsUUID()
  runId: string;

  @ApiPropertyOptional({ description: 'Skill name; derived from the run when omitted' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ type: PromoteRunDistillDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => PromoteRunDistillDto)
  distill?: PromoteRunDistillDto;
}
