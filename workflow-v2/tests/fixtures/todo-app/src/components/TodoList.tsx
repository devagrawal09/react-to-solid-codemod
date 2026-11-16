import { useState } from "react";
import { TodoItem } from "./TodoItem";
import { useFilter } from "../hooks/useFilter";
import { useTheme } from "./ThemeContext";

type Todo = { id: string; title: string; done: boolean };

export function TodoList({ initial }: { initial: Todo[] }) {
  const [todos, setTodos] = useState(initial);
  const [draft, setDraft] = useState("");
  const { filter, setFilter, label } = useFilter("all");
  const { dark, toggle } = useTheme();

  const visible = todos.filter((t) => (filter === "all" ? true : filter === "done" ? t.done : !t.done));
  const remaining = todos.filter((t) => !t.done).length;

  const add = () => {
    if (!draft.trim()) return;
    setTodos([...todos, { id: String(Date.now()), title: draft, done: false }]);
    setDraft("");
  };
  const toggleTodo = (id: string) => setTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));

  if (todos.length === 0) return <p className="empty">Nothing to do</p>;

  return (
    <section className={dark ? "list dark" : "list"}>
      <h2>{label} ({remaining} left)</h2>
      <button onClick={toggle}>Theme</button>
      <select value={filter} onChange={(e) => setFilter(e.target.value as "all")}>
        <option value="all">All</option>
        <option value="open">Open</option>
        <option value="done">Done</option>
      </select>
      <ul>
        {visible.map((todo) => (
          <TodoItem key={todo.id} todo={todo} onToggle={toggleTodo} highlight={todo.title.includes("!")} />
        ))}
      </ul>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={add}>Add</button>
    </section>
  );
}
