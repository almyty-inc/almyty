import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Attach or replace the customer-managed CMK for the caller's org. `cmkArn`
 * must look like a KMS key ARN; the region is derived from it when omitted.
 */
export class SetCmkDto {
  @Matches(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[\w-]+$/, {
    message: 'cmkArn must be a valid AWS KMS key ARN',
  })
  cmkArn: string;

  @IsOptional()
  @IsString()
  awsRegion?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SetKmsEnabledDto {
  @IsBoolean()
  enabled: boolean;
}
