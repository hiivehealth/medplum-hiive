Subject: Red Rover API to FHIR R4: Please Complete Mapping Clarification Workbook

Hi Red Rover team,

We are mapping your v2 patient and encounter APIs to FHIR R4 and would appreciate your help confirming the source-field definitions and appropriate translations. We have attached **red-rover-mapping-review.xlsx** with our recommended FHIR resources and elements for your review. Please confirm each recommendation or provide a correction and supporting explanation.

Could you please complete the workbook as follows?

1. **Mapping Questions:** Answer the three terminology questions covering patient gender, encounter class and encounter status, then the questions for all 22 fields not yet mapped by our connector. We have also included two date-semantics questions.
2. **Nested Fields:** Clarify the individual demographics and military-data fields grouped within the patient response.
3. **Reference Requests:** Provide the relevant data dictionaries, complete code sets, security requirements and any recommended FHIR R4 implementation guide or crosswalk.
4. **Mapped Fields:** This tab documents the implemented mappings for context. Routine mappings are marked "No questions"; existing terminology/date questions are linked rather than repeated.

The **Mapping Questions** and **Nested Fields** tabs now start with a recommended resource, review status, recommended FHIR element and specific review request. Rows marked **Needs review** identify uncertainty about source meaning, profile/security requirements, resource choice or linked resources. Where more than one resource could apply, please answer the question that distinguishes the options and confirm the appropriate model.

Please fill in the green response columns with your answer, confirmed or corrected FHIR mapping, supporting documentation/code-set references, responder name and response status. If another person owns a question, please identify the appropriate contact. The gray Hiive mapping-decision column is for our subsequent review.

In particular, we need to understand whether patient gender means administrative gender, birth sex or gender identity; whether encounter class and status support our proposed FHIR translations; and whether patient/encounter aliases represent identifiers, alternate names or another concept. We also need the meaning and required enforcement of confidentiality/VIP codes, including zero, null and missing values.

The recommended FHIR mappings are preliminary, not approved. Please identify any differences between our UAT installation, production and other sites. "Unsupported" means our connector has not implemented or approved the mapping yet; it does not mean the field is invalid or FHIR cannot represent it.

The workbook contains field names and terminology codes/displays only, with no patient-level chart data or credentials. Please use synthetic examples and documentation links rather than patient information in your responses.

We have performed a read-only UAT retrieval and generated an offline review draft only. No resources have been imported by this connector, and no clinical write-back has occurred. Your answers will support our separate mapping and security review, not authorize imports or writes.

Thanks,
Paul