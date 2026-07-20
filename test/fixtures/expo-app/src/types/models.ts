export interface User {
  id: number;
  name: string;
}
export type TaskStatus = 'open' | 'done';
export interface Task {
  id: number;
  userId: number;
  status: TaskStatus;
}
