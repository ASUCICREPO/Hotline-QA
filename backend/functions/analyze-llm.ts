import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand 
} from '@aws-sdk/client-s3';
import { 
  BedrockRuntimeClient, 
  ConverseCommand,
  ConversationRole,
  ContentBlock,
  SystemContentBlock
} from '@aws-sdk/client-bedrock-runtime';

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});
const { BUCKET_NAME } = process.env;

if (!BUCKET_NAME) {
  throw new Error('Required environment variable BUCKET_NAME must be set');
}

// Model ID for Amazon Nova Pro
const MODEL_ID = 'amazon.nova-pro-v1:0';

// Input from Step Functions or S3 event
interface AnalyzeEvent {
  bucket?: string;
  formattedKey?: string;
  // For S3 events
  Records?: Array<{
    s3: {
      bucket: {
        name: string;
      };
      object: {
        key: string;
      };
    };
  }>;
}

interface FormattedTranscript {
  summary: string;
  transcript: Array<{
    speaker: string;
    text: string;
    beginTime: string;
    endTime: string;
  }>;
}

export const handler = async (event: AnalyzeEvent): Promise<any> => {
  console.log('Received event:', JSON.stringify(event, null, 2));
  
  // Determine bucket and key from either Step Functions input or S3 event
  let bucket = event.bucket || '';
  let formattedKey = event.formattedKey || '';
  
  // If this is an S3 event, extract bucket and key
  if (event.Records && event.Records.length > 0) {
    const record = event.Records[0];
    bucket = record.s3.bucket.name;
    formattedKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
  }
  
  // Use environment variable if bucket is not provided
  if (!bucket) {
    bucket = BUCKET_NAME;
  }
  
  if (!formattedKey) {
    throw new Error('No formatted transcript key provided');
  }
  
  try {
    // Get the formatted transcript from S3
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: formattedKey
    });
    
    const response = await s3Client.send(getCommand);
    const body = await response.Body?.transformToString();
    
    if (!body) {
      throw new Error(`Empty response body for ${formattedKey}`);
    }
    
    // Parse the formatted transcript
    const formattedTranscript: FormattedTranscript = JSON.parse(body);
    
    // Create the result key in the results/llmOutput folder
    const resultKey = formattedKey.replace('transcripts/formatted/', 'results/llmOutput/').replace('formatted_', 'analysis_');
    
    // Analyze the transcript using Bedrock
    const analysisResult = await analyzeTranscript(formattedTranscript);
    
    // Save the analysis result to S3
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: resultKey,
      Body: JSON.stringify(analysisResult, null, 2),
      ContentType: 'application/json'
    });
    
    await s3Client.send(putCommand);
    console.log(`Successfully analyzed transcript and saved results to ${resultKey}`);
    
    // Return the result for Step Functions
    return {
      bucket,
      formattedKey,
      resultKey,
      status: 'SUCCESS'
    };
  } catch (error) {
    console.error(`Error analyzing transcript ${formattedKey}:`, error);
    throw error;
  }
};

async function analyzeTranscript(formattedTranscript: FormattedTranscript): Promise<any> {
  // Prepare the transcript for the LLM
  const transcriptText = formattedTranscript.transcript
    .map(item => `${item.beginTime} ${item.speaker}: ${item.text}`)
    .join('\n\n');
  
  // Create the system message
  const systemMessage = 
  `
  You are an expert QA evaluator for a crisis counseling service that helps people in distress. 
  Your task is to objectively evaluate counselor performance based on call transcripts using the rubric.

  **EVALUATION APPROACH:**
  1. First, read the entire transcript to understand the full context and flow of the conversation
  2. For each rubric item, search for specific evidence that meets or fails to meet the criteria
  3. Apply a strict, consistent scoring standard across all evaluations
  4. Provide precise evidence with timestamps for each score
  5. Include a brief, factual observation explaining your scoring decision

  **SCORING PRINCIPLES:**
  - Score based ONLY on evidence present in the transcript
  - Default to the lower score when criteria are partially met
  - Require clear, unambiguous evidence for full points
  - Do not make assumptions about what might have happened off-transcript
  - Consider the full context of the conversation when evaluating specific moments

  For **every** score you assign:
  - Pick exactly one checkbox value.
  - Cite the exact transcript line(s) that triggered that score.
  - If you can't find evidence, set evidence to "N/A".

  **Do NOT** give full marks by default. If a criterion isn't explicitly met, deduct points.  

  **Strict Scoring Rules**  
  1. Review the rubric definition for each item.  
  2. If it only partially meets it, score the middle option (e.g., "Somewhat").  
  3. Only score "1"/"2"/"4" etc. when you find unambiguous, on-point evidence.  
  4. Always include a one-sentence rationale under "observation" explaining the deduction.

  **OUTPUT FORMAT:**
  - After you evaluate, output **only** valid JSON — no free text, no markdown, no checkboxes.
  - **DO NOT wrap the JSON in triple backticks or quotes.**
  - Your JSON must be an object whose keys are the exact rubric question names (e.g. "Tone", "Professional", etc.).
  - For each item, the value must be an object with:
      "score": <0|1|2|…>,
      "label": "<Yes/No/Somewhat>",
      "observation": "<your concise rationale>",
      "evidence": "<timestamp> <speaker>: <exact transcript line>" (IMPORTANT: Always include the timestamp)
  - **Only** use lines provided in the user transcript for evidence. Do **not** invent or paraphrase. If no line matches, set evidence to "N/A".

  **Example**
    {
      "Tone": {
        "score": 1,
        "label": "Yes",
        "observation": "Calm and supportive tone.",
        "evidence": "00:24.500 AGENT: It's great that you're reaching out."
      }
    }

  **VERIFICATION CHECKLIST:**
  Before finalizing your evaluation:
  1. Confirm each score has supporting evidence from the transcript
  2. Verify all required rubric items are scored
  3. Check that observations are factual and not interpretive
  4. Ensure JSON structure is valid and complete

  **EVALUATION RUBRIC:**

**RAPPORT & CONNECTION**
1. Empathetic Tone: Was the counselor's tone calm, patient, and genuinely supportive?
   - 0 No - Tone was rushed, impatient, dismissive, or apathetic.
   - 1 Yes - Tone was warm, natural, calm, and patient.

2. Professionalism: Was the counselor professional during the contact?
   - 0 No - Used slang, shared excessive personal information, or engaged in unsuitable conversation.
   - 1 Yes - Conversation was appropriate and suitable for a crisis counselor.

3. Active Listening: Did the counselor engage in a balanced, conversational dialogue?
   - 0 No - Counselor either dominated the conversation or was largely unresponsive.
   - 1 Yes - Conversation was balanced with a natural back-and-forth; counselor was responsive.

4. Initial Assurance: Did the counselor provide a supportive initial statement?
   - 0 No - Did not thank the caller for reaching out or assure them help was available.
   - 1 Yes - Counselor assured the contact they did the right thing by reaching out.

**COUNSELING PROCESS & SAFETY**
5. Problem Exploration: Did the counselor encourage the contact to explain their problem(s) without interruption?
   - 0 No - Counselor interrupted, seemed disinterested, or asked only closed-ended questions.
   - 1 Yes - Counselor used open-ended questions to prompt for and understand the problem.

6. Risk Assessment: Did the counselor assess for immediate safety concerns?
   - 0 No - Counselor failed to ask about critical safety concerns when indicators were present.
   - 1 Yes - Counselor asked appropriate clarifying questions about safety. (Score 1 if no safety concerns were present).

7. Collaborative Planning: Did the counselor collaborate with the contact to develop a plan?
   - 0 No - Counselor told the contact what to do without seeking their input.
   - 1 Yes - Counselor worked with the contact by asking how they would like to handle the situation.

8. Call Closure: Did the counselor end the contact appropriately?
   - 0 No - Ended the call abruptly or without a closing statement.
   - 1 Yes - Ended the contact with an appropriate closing statement and invited the contact to call back if needed.

  `;

  // Create the user message with the transcript
  const userMessage = `Here is the call transcript to evaluate. The transcript includes a summary followed by the conversation between the AGENT (counselor) and CUSTOMER (caller). 
  Now act as a master evaluator and based on all the infromation you have, analyze the transcript accordingly. Give accurate and detailed assessment which is free of any form of bias, 
  you don't always have to give a full score, you have to evaluate such that we can provide a constructive feedback and improve overall performance of the counselor.
  This evaluation will be used to provide feedback to the counselor and improve our crisis intervention services.

  SUMMARY:
  ${formattedTranscript.summary}

  TRANSCRIPT:
  ${transcriptText}

  Please analyze this transcript according to rubric and provide a detailed assessment. 

  **EVALUATION INSTRUCTIONS:**
  1. Evaluate strictly according to the rubric criteria
  2. Provide specific evidence with timestamps for each score
  3. Be objective and consistent in your scoring
  4. Return only the JSON evaluation results without additional commentary

  Your evaluation will directly impact counselor training and service quality, so accuracy and consistency are essential.
  
  After successfully analyzing the transcript and generating the output, take some time to reflect back on the analysis you did,
  see whether it meets all the requirements and if it is accurate, detailed and free of any form of bias. If you see any issues,
  please correct them and then return the final output. Make sure the results needs to be very accurte as it will help us to 
  improve overall performance of the counselor which ultimately will result in better service to our customers and help 
  those who are in need of help.  `;

  try {
    // Use the Conversational API with the correct structure
    // Move system prompt to top-level system field, not in messages array
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      
      // Top-level system prompt as an array of SystemContentBlock
      system: [{ text: systemMessage }] as SystemContentBlock[],
      
      // Only user role in messages array
      messages: [
        { 
          role: 'user' as ConversationRole, 
          content: [{ text: userMessage }] as ContentBlock[]
        }
      ],
      
      inferenceConfig: {
        //maxTokens: 4096,
        temperature: 0.1,
        topP: 0.9
      }
    });
    
    const response = await bedrockClient.send(command);
    
    // Extract the content from the response
    // Bedrock returns the chat response under response.output?.message?.content
    let content = '';
    if (response.output?.message?.content && response.output.message.content.length > 0) {
      content = response.output.message.content[0].text || '';
    }
    
    // Try to parse the content as JSON if it's in JSON format
    try {
      return JSON.parse(content);
    } catch (e) {
      // If parsing fails, return the raw content
      return { 
        raw_analysis: content,
        summary: formattedTranscript.summary
      };
    }
  } catch (error) {
    console.error('Error calling Bedrock:', error);
    throw new Error(`Failed to analyze transcript: ${error}`);
  }
}