// Times lib/compiler-facts.wasm under wasmtime 42 (the engine's version): compile, instantiate,
// analyze per file, and linear memory after the run. Prints one JSON object.
use std::time::Instant;
use wasmtime::{Engine, Instance, Module, Store};

fn main() {
    let mut args = std::env::args().skip(1);
    let wasm = args.next().unwrap();
    let list = std::fs::read_to_string(args.next().unwrap()).unwrap();
    let engine = Engine::default();
    let t = Instant::now();
    let module = Module::new(&engine, std::fs::read(&wasm).unwrap()).unwrap();
    let compile = t.elapsed().as_secs_f64() * 1e3;
    let t = Instant::now();
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).unwrap();
    let instantiate = t.elapsed().as_secs_f64() * 1e3;
    let memory = instance.get_memory(&mut store, "memory").unwrap();
    let initial = memory.data_size(&store);
    let alloc = instance.get_typed_func::<u32, u32>(&mut store, "alloc").unwrap();
    let dealloc = instance.get_typed_func::<(u32, u32), ()>(&mut store, "dealloc").unwrap();
    let analyze = instance.get_typed_func::<(u32, u32, u32, u32), u32>(&mut store, "analyze_utf8").unwrap();
    let result_ptr = instance.get_typed_func::<(), u32>(&mut store, "result_ptr").unwrap();
    let mut times = Vec::new();
    for file in list.lines() {
        let source = std::fs::read(file).unwrap();
        let t = Instant::now();
        let (s, n) = (alloc.call(&mut store, source.len() as u32).unwrap(), alloc.call(&mut store, file.len() as u32).unwrap());
        memory.write(&mut store, s as usize, &source).unwrap();
        memory.write(&mut store, n as usize, file.as_bytes()).unwrap();
        let len = analyze.call(&mut store, (s, source.len() as u32, n, file.len() as u32)).unwrap();
        let mut out = vec![0; len as usize];
        let ptr = result_ptr.call(&mut store, ()).unwrap() as usize;
        memory.read(&store, ptr, &mut out).unwrap();
        dealloc.call(&mut store, (s, source.len() as u32)).unwrap();
        dealloc.call(&mut store, (n, file.len() as u32)).unwrap();
        times.push(t.elapsed().as_secs_f64() * 1e3);
        if std::env::var("PER_FILE").is_ok() {
            eprintln!("{:.1}\t{:.1}\t{}", times.last().unwrap(), memory.data_size(&store) as f64 / 1048576.0, file);
        }
    }
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let total: f64 = times.iter().sum();
    println!(
        "{{\"files\":{},\"compileMs\":{compile:.1},\"instantiateMs\":{instantiate:.2},\"memoryInitialMB\":{:.1},\"memoryAfterMB\":{:.1},\"totalMs\":{total:.0},\"avgMs\":{:.2},\"medianMs\":{:.2},\"maxMs\":{:.1}}}",
        times.len(),
        initial as f64 / 1048576.0,
        memory.data_size(&store) as f64 / 1048576.0,
        total / times.len() as f64,
        sorted[sorted.len() / 2],
        sorted[sorted.len() - 1]
    );
}
