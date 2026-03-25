import { useEffect, useState, useCallback } from "react";
import { listTasks, type Task } from "./api.js";
import { NewTaskForm } from "./components/NewTaskForm.js";
import { TaskCard } from "./components/TaskCard.js";
import { TaskDetail } from "./components/TaskDetail.js";

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listTasks().then(setTasks).catch(console.error);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="min-h-screen max-w-3xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Phil</h1>
        <span className="text-sm text-gray-500">AI Coding Agent</span>
      </header>

      {selectedTaskId ? (
        <TaskDetail
          taskId={selectedTaskId}
          onBack={() => setSelectedTaskId(null)}
        />
      ) : (
        <>
          <NewTaskForm onCreated={refresh} />
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">
              Tasks {tasks.length > 0 && `(${tasks.length})`}
            </h2>
            {tasks.length === 0 && (
              <p className="text-gray-500 text-sm">No tasks yet. Submit one above.</p>
            )}
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={() => setSelectedTaskId(task.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
