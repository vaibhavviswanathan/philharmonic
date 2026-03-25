import {
  type AgentPhase,
  type AllowedToolsConfig,
  type ToolPermission,
  defaultAllowedTools,
} from "@phil/shared";

export interface ToolCallRecord {
  tool: string;
  phase: AgentPhase;
  permission: ToolPermission;
  timestamp: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export class ToolProxy {
  private config: AllowedToolsConfig;
  private currentPhase: AgentPhase = "implement";
  private auditLog: ToolCallRecord[] = [];

  constructor(config?: AllowedToolsConfig) {
    this.config = config ?? defaultAllowedTools;
  }

  setPhase(phase: AgentPhase): void {
    this.currentPhase = phase;
  }

  getPermission(toolName: string): ToolPermission {
    const phaseConfig = this.config[this.currentPhase];
    return phaseConfig[toolName] ?? "denied";
  }

  async execute<T>(
    toolName: string,
    input: unknown,
    handler: (input: unknown) => Promise<T>,
  ): Promise<T> {
    const permission = this.getPermission(toolName);
    const record: ToolCallRecord = {
      tool: toolName,
      phase: this.currentPhase,
      permission,
      timestamp: new Date().toISOString(),
      input,
    };

    if (permission === "denied") {
      record.error = `Tool '${toolName}' is denied in phase '${this.currentPhase}'`;
      this.auditLog.push(record);
      throw new Error(record.error);
    }

    try {
      const result = await handler(input);
      record.output = result;
      this.auditLog.push(record);
      return result;
    } catch (err) {
      record.error = String(err);
      this.auditLog.push(record);
      throw err;
    }
  }

  getAuditLog(): ToolCallRecord[] {
    return this.auditLog;
  }
}
