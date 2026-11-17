import type { Project } from "../domain/types.ts";
import {
  validateProjectKey,
  validateProjectName,
} from "../domain/validation.ts";
import type { TransactionPorts } from "./ports.ts";

export async function createProject(
  ports: TransactionPorts,
  input: { key: string; name: string },
): Promise<Project> {
  const { key } = input;
  validateProjectKey(key);
  const name = validateProjectName(input.name);
  return ports.projects.create({ key, name });
}

export async function listProjects(ports: TransactionPorts): Promise<Project[]> {
  return ports.projects.list();
}
