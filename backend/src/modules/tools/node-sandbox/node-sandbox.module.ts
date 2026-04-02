import { Module } from '@nestjs/common';
import { NodeSandboxService } from './node-sandbox.service';
import { DependencyManagerService } from './dependency-manager.service';
import { SdkIntrospectorService } from './sdk-introspector.service';
import { SdkCodeAssemblerService } from './sdk-code-assembler.service';

@Module({
  providers: [
    NodeSandboxService,
    DependencyManagerService,
    SdkIntrospectorService,
    SdkCodeAssemblerService,
  ],
  exports: [
    NodeSandboxService,
    DependencyManagerService,
    SdkIntrospectorService,
    SdkCodeAssemblerService,
  ],
})
export class NodeSandboxModule {}
