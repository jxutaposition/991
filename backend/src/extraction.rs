/// Post-session extraction pipeline.
///
/// Converts distillations → abstracted_tasks → agent PRs.
/// Phase 2 implementation.
pub struct ExtractionPipeline;

impl ExtractionPipeline {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ExtractionPipeline {
    fn default() -> Self {
        Self::new()
    }
}
