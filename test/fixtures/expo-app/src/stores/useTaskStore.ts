import { create } from 'zustand';
export interface TaskStore {
  tasks: string[];
  addTask: (t: string) => void;
}
export const useTaskStore = create<TaskStore>((set) => ({ tasks: [], addTask: () => {} }));
