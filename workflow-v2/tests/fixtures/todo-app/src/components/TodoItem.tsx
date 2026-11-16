type Todo = { id: string; title: string; done: boolean };

export function TodoItem({ todo, onToggle, highlight = false }: { todo: Todo; onToggle: (id: string) => void; highlight?: boolean }) {
  const className = todo.done ? "todo done" : highlight ? "todo hot" : "todo";
  return (
    <li className={className}>
      <label htmlFor={todo.id}>
        <input id={todo.id} type="checkbox" checked={todo.done} onChange={() => onToggle(todo.id)} />
        {todo.title}
      </label>
    </li>
  );
}
