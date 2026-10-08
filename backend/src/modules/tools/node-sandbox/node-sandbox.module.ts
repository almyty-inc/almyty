import { Module } from '@nestjs/common';
import { NodeSandboxService } from './node-sandbox.service';
import { QuickJsSandboxService } from './quickjs-sandbox.service';
import { DependencyManagerService } from './dependency-manager.service';
import { SdkIntrospectorService } from './sdk-introspector.service';
import { SdkCodeAssemblerService } from './sdk-code-assembler.service';

@Module({
  providers: [
    NodeSandboxService,
    QuickJsSandboxService,
    DependencyManagerService,
    SdkIntrospectorService,
    SdkCodeAssemblerService,
  ],
  exports: [
    NodeSandboxService,
    QuickJsSandboxService,
    DependencyManagerService,
    SdkIntrospectorService,
    SdkCodeAssemblerService,
  ],
})
export class NodeSandboxModule {}
