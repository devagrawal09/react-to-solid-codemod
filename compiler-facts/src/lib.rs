//! oxc's React Compiler with the facts patch, as a WASM module with a byte-buffer ABI:
//! `alloc`/`dealloc` for inputs, `analyze(source, filename)` as UTF-8 pointer/length pairs,
//! and the JSON result read back through `result_ptr`/`result_len`. No imports, so the
//! module needs nothing from its host but memory reads and writes.
//!
//! Positions are Babel-style `"line:column"` keys (1-based line, 0-based UTF-16 column)
//! so results join with ast-grep or Babel nodes by location.

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_react_compiler::{FunctionFacts, FunctionStatus, LintDiagnostic, PluginOptions};
use oxc_semantic::SemanticBuilder;
use oxc_span::{SourceType, Span};
use serde_json::{json, Value as Json};
use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len as usize);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from one `alloc` call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    drop(Vec::from_raw_parts(ptr, 0, len as usize));
}

/// # Safety
/// Both ranges must be initialised UTF-8 inside buffers from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn analyze_utf8(
    source_ptr: *const u8,
    source_len: u32,
    filename_ptr: *const u8,
    filename_len: u32,
) -> u32 {
    let source = std::str::from_utf8_unchecked(std::slice::from_raw_parts(source_ptr, source_len as usize));
    let filename =
        std::str::from_utf8_unchecked(std::slice::from_raw_parts(filename_ptr, filename_len as usize));
    let json = analyze(source, filename).to_string().into_bytes();
    let len = json.len() as u32;
    RESULT.with(|r| *r.borrow_mut() = json);
    len
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

/// Analyses `source` and returns the JSON the module hands to JavaScript.
pub fn analyze(source: &str, filename: &str) -> Json {
    let source_type = SourceType::from_path(filename).unwrap_or_else(|_| SourceType::tsx());
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let lines = LineIndex::new(source);
    if let Some(error) = parsed.diagnostics.first() {
        return json!({ "parseError": error.message.to_string(), "functions": [], "diagnostics": [] });
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    let options = PluginOptions {
        panic_threshold: oxc_react_compiler::PanicThreshold::None,
        ..PluginOptions::default()
    };
    let (functions, diagnostics) =
        oxc_react_compiler::facts(&parsed.program, &semantic, &allocator, options);
    json!({
        "parseError": null,
        "functions": functions.iter().map(|f| function_json(f, &lines)).collect::<Vec<_>>(),
        "diagnostics": diagnostics.iter().map(|d| json!({ "reason": d.message.to_string() })).collect::<Vec<_>>(),
    })
}

fn function_json(f: &FunctionFacts, lines: &LineIndex) -> Json {
    let status = match f.status {
        FunctionStatus::Compiled => "compiled",
        FunctionStatus::Bailout => "bailout",
        FunctionStatus::Skipped => "skipped",
    };
    let reactive = f.reactive.as_ref().map(|r| {
        json!({
            "identifiers": r.identifiers.iter().map(|i| json!({
                "id": i.declaration_id, "name": i.name, "loc": i.span.map(|s| lines.key(s)), "scope": i.scope,
            })).collect::<Vec<_>>(),
            "edges": r.edges,
            "named": r.named.iter().map(|n| json!({
                "loc": lines.key(n.span), "id": n.declaration_id, "name": n.name, "reactive": n.reactive,
                "isParam": n.is_param, "ownScope": n.own_scope, "enclosingScope": n.enclosing_scope,
                "operandIds": n.operand_ids,
            })).collect::<Vec<_>>(),
            "scopes": r.scopes.iter().map(|s| json!({
                "id": s.id, "line": s.span.map(|sp| lines.line_col(sp.start).0),
                "dependencies": s.dependencies.iter().map(|d| json!({
                    "id": d.declaration_id, "name": d.name, "reactive": d.reactive,
                    "path": d.path.iter().map(|(property, optional)| json!({ "property": property, "optional": optional })).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
                "declarations": s.declarations, "merged": s.merged,
            })).collect::<Vec<_>>(),
            "returns": r.returns.iter().map(|ret| json!({ "loc": lines.key(ret.span), "id": ret.declaration_id, "reactive": ret.reactive })).collect::<Vec<_>>(),
            "reactiveIds": r.reactive_ids,
        })
    });
    json!({
        "loc": lines.key(f.span),
        "status": status,
        "memoSlots": f.memo_slots,
        "diagnostics": f.diagnostics.iter().map(|d| diagnostic_json(d, lines)).collect::<Vec<_>>(),
        "reactive": reactive,
    })
}

fn diagnostic_json(d: &LintDiagnostic, lines: &LineIndex) -> Json {
    let line = d
        .diagnostic
        .labels
        .first()
        .map(|l| lines.line_col(l.offset() as u32).0);
    json!({ "category": format!("{:?}", d.category), "reason": d.diagnostic.message.to_string(), "line": line })
}

/// Byte offsets to Babel positions.
struct LineIndex<'s> {
    source: &'s str,
    starts: Vec<u32>,
}

impl<'s> LineIndex<'s> {
    fn new(source: &'s str) -> Self {
        let mut starts = vec![0];
        starts.extend(source.match_indices('\n').map(|(i, _)| i as u32 + 1));
        Self { source, starts }
    }

    fn line_col(&self, offset: u32) -> (usize, usize) {
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        let start = self.starts[line] as usize;
        let end = (offset as usize).min(self.source.len());
        let column = self
            .source
            .get(start..end)
            .map_or(0, |s| s.encode_utf16().count());
        (line + 1, column)
    }

    fn key(&self, span: Span) -> String {
        let (line, column) = self.line_col(span.start);
        format!("{line}:{column}")
    }
}

