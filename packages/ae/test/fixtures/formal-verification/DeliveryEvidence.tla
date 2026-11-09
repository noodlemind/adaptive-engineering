------------------------ MODULE DeliveryEvidence ------------------------
EXTENDS Integers

\* Finite reference: baseline plus at most two edits, two accepted intent versions.
\* Lock/Edit abstract gate.mjs; Verify abstracts evidence.mjs/verify.mjs;
\* Compound abstracts the verified-delivery lane of compound.mjs.
\* mode is the Engineer obligation, not a kernel-authenticated task mode.
VARIABLES mode, locked, revision, intent, proofRevision, proofIntent,
          mutated, lastMutationMode, ready, compounded, insight

vars == <<mode, locked, revision, intent, proofRevision, proofIntent,
          mutated, lastMutationMode, ready, compounded, insight>>

Init == /\ mode \in {"Answer", "Investigate", "Review", "Deliver"}
        /\ locked = FALSE /\ revision = 0 /\ intent = 0
        /\ proofRevision = -1 /\ proofIntent = -1
        /\ mutated = FALSE /\ lastMutationMode = "none"
        /\ ready = FALSE /\ compounded = FALSE /\ insight = FALSE

EnterDeliver == /\ mode # "Deliver" /\ ~locked
                /\ mode' = "Deliver"
                /\ UNCHANGED <<locked, revision, intent, proofRevision,
                     proofIntent, mutated, lastMutationMode, ready, compounded, insight>>

Lock == /\ mode = "Deliver" /\ ~locked
        /\ locked' = TRUE /\ intent' = 1
        /\ UNCHANGED <<mode, revision, proofRevision, proofIntent, mutated,
                       lastMutationMode, ready, compounded, insight>>

Edit == /\ mode = "Deliver" /\ locked /\ ~compounded /\ revision < 2
        /\ revision' = revision + 1 /\ mutated' = TRUE
        /\ lastMutationMode' = mode /\ ready' = FALSE
        /\ proofRevision' = -1 /\ proofIntent' = -1
        /\ UNCHANGED <<mode, locked, intent, compounded, insight>>

Amend == /\ mode = "Deliver" /\ locked /\ ~compounded /\ intent < 2
         /\ intent' = intent + 1 /\ ready' = FALSE
         /\ proofRevision' = -1 /\ proofIntent' = -1
         /\ UNCHANGED <<mode, locked, revision, mutated, lastMutationMode, compounded, insight>>

Review == /\ mode = "Deliver" /\ locked /\ ~ready /\ ~compounded
          /\ ready' = TRUE
          /\ UNCHANGED <<mode, locked, revision, intent, proofRevision,
                         proofIntent, mutated, lastMutationMode, compounded, insight>>

Verify == /\ mode = "Deliver" /\ locked /\ ready /\ ~compounded
          /\ proofRevision' = revision /\ proofIntent' = intent
          /\ UNCHANGED <<mode, locked, revision, intent, mutated,
                         lastMutationMode, ready, compounded, insight>>

Compound == /\ mode = "Deliver" /\ locked /\ ready /\ ~compounded
            /\ proofRevision = revision /\ proofIntent = intent
            /\ compounded' = TRUE
            /\ UNCHANGED <<mode, locked, revision, intent, proofRevision,
                           proofIntent, mutated, lastMutationMode, ready, insight>>

\* Unverified --insight capture is legal and does not complete delivery.
CaptureInsight == /\ ~insight /\ insight' = TRUE
                  /\ UNCHANGED <<mode, locked, revision, intent, proofRevision,
                       proofIntent, mutated, lastMutationMode, ready, compounded>>

Terminal == /\ compounded /\ UNCHANGED vars
Idle == /\ ready /\ UNCHANGED vars

Next == EnterDeliver \/ Lock \/ Edit \/ Amend \/ Review \/ Verify \/ Compound \/ CaptureInsight \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Review) /\ WF_vars(Verify) /\ WF_vars(Compound)

TypeOK == /\ mode \in {"Answer", "Investigate", "Review", "Deliver"}
          /\ locked \in BOOLEAN /\ revision \in 0..2 /\ intent \in 0..2
          /\ proofRevision \in -1..2 /\ proofIntent \in -1..2
          /\ mutated \in BOOLEAN /\ ready \in BOOLEAN
          /\ compounded \in BOOLEAN /\ insight \in BOOLEAN
          /\ lastMutationMode \in {"none", "Deliver"}
IntentBeforeMutation == mutated => locked
CurrentEvidence == compounded => (locked /\ proofRevision = revision /\ proofIntent = intent)
ModeBoundary == mutated => lastMutationMode = "Deliver"
Progress == ready ~> compounded

\* Negative control: removing the evidence guard permits premature compound.
UnsafeCompound == /\ mode = "Deliver" /\ locked /\ ready /\ ~compounded
                  /\ compounded' = TRUE
                  /\ UNCHANGED <<mode, locked, revision, intent, proofRevision,
                       proofIntent, mutated, lastMutationMode, ready, insight>>
UnsafeNext == Next \/ UnsafeCompound
UnsafeSpec == Init /\ [][UnsafeNext]_vars /\ WF_vars(Review) /\ WF_vars(Verify) /\ WF_vars(Compound)

\* Negative control: enabled workflow can stutter forever without verification.
NoProgressNext == EnterDeliver \/ Lock \/ Edit \/ Amend \/ Review \/ Compound \/ CaptureInsight \/ Terminal \/ Idle
NoProgressSpec == Init /\ [][NoProgressNext]_vars /\ WF_vars(Review) /\ WF_vars(Compound)
=============================================================================
