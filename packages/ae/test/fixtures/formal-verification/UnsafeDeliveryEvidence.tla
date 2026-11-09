--------------------- MODULE UnsafeDeliveryEvidence ---------------------
VARIABLES mode, locked, revision, intent, proofRevision, proofIntent,
          mutated, lastMutationMode, ready, compounded, insight
Model == INSTANCE DeliveryEvidence
Spec == Model!UnsafeSpec
TypeOK == Model!TypeOK
IntentBeforeMutation == Model!IntentBeforeMutation
CurrentEvidence == Model!CurrentEvidence
ModeBoundary == Model!ModeBoundary
Progress == Model!Progress
=============================================================================
