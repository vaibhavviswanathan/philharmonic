import { useState, useEffect, useCallback } from "react";
import { listTasks, rebaseTask, type Task } from "../api.js";

export function useTasks(projectId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listTasks(projectId);
      setTasks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const triggerRebase = useCallback(async (taskId: string): Promise<Task> => {
    const newTask = await rebaseTask(taskId);
    setTasks((prev) => [...prev, newTask]);
    return newTask;
  }, []);

  return { tasks, loading, error, refresh, triggerRebase };
}
