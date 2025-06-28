import React, { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ArrowRight, Zap, Wifi, WifiOff } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { toast } from 'sonner';

// Type definitions for Web Serial API
declare global {
  interface Navigator {
    serial: Serial;
  }
}

interface Serial {
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface CO2DataPoint {
  timestamp: string;
  co2_ppm: number;
  formattedTime: string;
}

interface LoggingSession {
  id: number;
  startTime: string;
  endTime: string;
  data: CO2DataPoint[];
}

const Index = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [sessions, setSessions] = useState<LoggingSession[]>([]);
  const [currentSessionIndex, setCurrentSessionIndex] = useState(0);
  const [flipperPort, setFlipperPort] = useState<SerialPort | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter | null>(null);

  // Request permission to access Flipper Zero
  const requestFlipperPort = async (): Promise<SerialPort | null> => {
    try {
      const port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0x0483, usbProductId: 0x5740 }]
      });
      return port;
    } catch (err) {
      console.error('No Flipper Zero or permission denied:', err);
      return null;
    }
  };

  // Auto-detect previously granted Flipper ports
  const findGrantedFlippers = async (): Promise<SerialPort[]> => {
    const ports = await navigator.serial.getPorts();
    return ports.filter(port => {
      const info = port.getInfo();
      return info.usbVendorId === 0x0483 && info.usbProductId === 0x5740;
    });
  };

  // Open the serial port
  const openFlipperPort = async (port: SerialPort) => {
    await port.open({ baudRate: 230400 });
    console.log('Flipper Zero opened at 230400 baud');
    return {
      reader: port.readable!.getReader(),
      writer: port.writable!.getWriter()
    };
  };

  // Parse CSV data into sessions
  const parseCSVData = (csvContent: string): LoggingSession[] => {
    const lines = csvContent.split('\n').filter(line => line.trim());
    if (lines.length <= 1) return []; // No data or just header

    const dataPoints: CO2DataPoint[] = [];
    
    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const [timestamp, co2_ppm] = lines[i].split(',');
      if (timestamp && co2_ppm) {
        const date = new Date(parseInt(timestamp) * 1000);
        dataPoints.push({
          timestamp,
          co2_ppm: parseInt(co2_ppm),
          formattedTime: date.toLocaleTimeString()
        });
      }
    }

    // Group into sessions (separated by more than 5 minutes)
    const sessions: LoggingSession[] = [];
    let currentSession: CO2DataPoint[] = [];
    
    for (let i = 0; i < dataPoints.length; i++) {
      const point = dataPoints[i];
      
      if (currentSession.length === 0) {
        currentSession.push(point);
      } else {
        const lastPoint = currentSession[currentSession.length - 1];
        const timeDiff = parseInt(point.timestamp) - parseInt(lastPoint.timestamp);
        
        if (timeDiff > 300) { // 5 minutes = 300 seconds
          // Start new session
          const startTime = new Date(parseInt(currentSession[0].timestamp) * 1000);
          const endTime = new Date(parseInt(lastPoint.timestamp) * 1000);
          
          sessions.push({
            id: sessions.length,
            startTime: startTime.toLocaleString(),
            endTime: endTime.toLocaleString(),
            data: [...currentSession]
          });
          
          currentSession = [point];
        } else {
          currentSession.push(point);
        }
      }
    }
    
    // Don't forget the last session
    if (currentSession.length > 0) {
      const startTime = new Date(parseInt(currentSession[0].timestamp) * 1000);
      const endTime = new Date(parseInt(currentSession[currentSession.length - 1].timestamp) * 1000);
      
      sessions.push({
        id: sessions.length,
        startTime: startTime.toLocaleString(),
        endTime: endTime.toLocaleString(),
        data: [...currentSession]
      });
    }
    
    return sessions;
  };

  // Read file from Flipper Zero with proper command execution handling
  const readFlipperFile = async () => {
    if (!writerRef.current || !readerRef.current) return;

    try {
      // Send command to read the CO2 logger file with correct filename
      const command = 'storage read /ext/apps_data/co2_logger/co2_log.csv\n';
      console.log('Sending command:', JSON.stringify(command));
      
      // Write the entire command at once to ensure proper transmission
      await writerRef.current.write(new TextEncoder().encode(command));
      
      console.log('Starting to read file from Flipper Zero...');
      
      let buffer = '';
      let csvContent = '';
      let foundHeader = false;
      let commandComplete = false;
      let commandEchoed = false;
      
      // Set a timeout for the entire operation
      const timeout = setTimeout(() => {
        console.log('Timeout reached - stopping file read');
        toast.error('Timeout reading file from Flipper Zero');
      }, 45000);
      
      while (!commandComplete) {
        const { value, done } = await readerRef.current.read();
        if (done) break;
        
        const text = new TextDecoder().decode(value);
        buffer += text;
        
        console.log('Received:', JSON.stringify(text));
        console.log('Current buffer length:', buffer.length);
        
        // Remove ANSI escape sequences and control characters
        const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
        
        // Wait for the command echo to complete first
        if (!commandEchoed) {
          if (buffer.includes('co2_log.csv')) {
            console.log('Command echo complete, waiting for file output...');
            commandEchoed = true;
            // Clear buffer after command echo
            buffer = '';
            continue;
          }
        }
        
        // Only start looking for CSV data after command echo is complete
        if (commandEchoed) {
          // Check for any error messages immediately
          if (buffer.includes('File not found') || 
              buffer.includes('Error') || 
              buffer.includes('Invalid') ||
              buffer.includes('No such file') ||
              buffer.includes('Cannot open') ||
              buffer.includes('Permission denied')) {
            console.log('Error detected in buffer:', buffer);
            toast.error('Error reading file: ' + buffer.split('\n').find(line => 
              line.includes('Error') || 
              line.includes('File not found') || 
              line.includes('Invalid') ||
              line.includes('No such file') ||
              line.includes('Cannot open') ||
              line.includes('Permission denied')
            ));
            clearTimeout(timeout);
            return;
          }
          
          // Look for the CSV header to start reading
          if (!foundHeader && (buffer.includes('Timestamp,CO2_PPM') || cleanText.includes('Timestamp,CO2_PPM'))) {
            foundHeader = true;
            console.log('Found CSV header, starting to collect data...');
            
            // Extract everything from the header onwards, cleaning ANSI codes
            const cleanBuffer = buffer.replace(/\x1b\[[0-9;]*m/g, '');
            const headerIndex = cleanBuffer.indexOf('Timestamp,CO2_PPM');
            if (headerIndex !== -1) {
              csvContent = cleanBuffer.substring(headerIndex);
            }
          } else if (foundHeader) {
            // Continue adding cleaned text to CSV content
            csvContent += cleanText;
          }
          
          // Check for command completion - look for the prompt
          if (foundHeader && (buffer.includes('>:') || buffer.includes('>'))) {
            console.log('Found command prompt, file reading complete');
            commandComplete = true;
            break;
          }
          
          // If we haven't found a header after reasonable time, show what we got
          if (!foundHeader && buffer.length > 1000) {
            console.log('No header found, showing raw buffer for debugging:', buffer);
            toast.error('Unexpected response from Flipper Zero. Check console for details.');
            clearTimeout(timeout);
            return;
          }
        }
        
        // Prevent buffer from getting too large
        if (buffer.length > 100000) {
          // Keep only the last 50KB
          buffer = buffer.slice(-50000);
        }
      }
      
      clearTimeout(timeout);
      
      console.log('Final CSV Content length:', csvContent.length);
      console.log('First 500 chars of CSV:', csvContent.substring(0, 500));
      
      if (csvContent && csvContent.includes('Timestamp,CO2_PPM')) {
        // Clean up the CSV content more thoroughly
        const lines = csvContent.split('\n');
        const cleanLines = [];
        let headerFound = false;
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          
          // Skip empty lines before header
          if (!headerFound && !trimmedLine) {
            continue;
          }
          
          // Found header
          if (trimmedLine === 'Timestamp,CO2_PPM') {
            headerFound = true;
            cleanLines.push(trimmedLine);
            continue;
          }
          
          // After header, collect data lines
          if (headerFound) {
            // Check if it's a valid data line (timestamp,number)
            if (trimmedLine.includes(',') && !trimmedLine.includes('>') && !trimmedLine.includes('storage')) {
              const parts = trimmedLine.split(',');
              if (parts.length === 2 && !isNaN(parseInt(parts[0])) && !isNaN(parseInt(parts[1]))) {
                cleanLines.push(trimmedLine);
              }
            } else if (trimmedLine.includes('>') || trimmedLine === '') {
              // Stop at command prompt or empty line after data
              break;
            }
          }
        }
        
        const cleanCSV = cleanLines.join('\n');
        console.log('Clean CSV length:', cleanCSV.length);
        console.log('Clean CSV preview:', cleanCSV.substring(0, 300));
        
        if (cleanLines.length > 1) { // More than just header
          const parsedSessions = parseCSVData(cleanCSV);
          setSessions(parsedSessions);
          setCurrentSessionIndex(0);
          
          if (parsedSessions.length > 0) {
            toast.success(`Found ${parsedSessions.length} logging sessions with ${parsedSessions.reduce((acc, session) => acc + session.data.length, 0)} total data points`);
          } else {
            toast.warning('CSV file found but no valid data could be parsed');
          }
        } else {
          toast.warning('CSV file found but appears to be empty or contains no data');
        }
      } else {
        toast.error('No CO2 data found - make sure the CO2 logger app has recorded data');
      }
    } catch (error) {
      console.error('Error reading file:', error);
      toast.error('Failed to read CO2 data from Flipper Zero');
    }
  };

  // Connect to Flipper Zero
  const connectToFlipper = async () => {
    setIsConnecting(true);
    
    try {
      // Try to find any already-granted Flipper ports
      let ports = await findGrantedFlippers();

      // If none found, request permission
      if (ports.length === 0) {
        const port = await requestFlipperPort();
        if (!port) {
          toast.error('Flipper Zero not found or permission denied');
          setIsConnecting(false);
          return;
        }
        ports = [port];
      }

      // Open the first Flipper Zero
      const { reader, writer } = await openFlipperPort(ports[0]);
      
      setFlipperPort(ports[0]);
      readerRef.current = reader;
      writerRef.current = writer;
      setIsConnected(true);
      toast.success('Connected to Flipper Zero!');
      
      // Automatically try to read the CO2 data
      setTimeout(() => {
        readFlipperFile();
      }, 1000);

    } catch (error) {
      console.error('Connection error:', error);
      toast.error('Failed to connect to Flipper Zero');
    }
    
    setIsConnecting(false);
  };

  // Disconnect from Flipper Zero
  const disconnect = async () => {
    if (flipperPort) {
      try {
        if (readerRef.current) {
          await readerRef.current.cancel();
          readerRef.current = null;
        }
        if (writerRef.current) {
          await writerRef.current.close();
          writerRef.current = null;
        }
        await flipperPort.close();
        setFlipperPort(null);
        setIsConnected(false);
        toast.success('Disconnected from Flipper Zero');
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    }
  };

  // Navigation functions
  const previousSession = () => {
    if (currentSessionIndex > 0) {
      setCurrentSessionIndex(currentSessionIndex - 1);
    }
  };

  const nextSession = () => {
    if (currentSessionIndex < sessions.length - 1) {
      setCurrentSessionIndex(currentSessionIndex + 1);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  const currentSession = sessions[currentSessionIndex];

  return (
    <div className="min-h-screen bg-black text-orange-400 font-mono">
      {/* Header */}
      <div className="bg-orange-500 text-black p-4">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
            <Zap className="w-8 h-8" />
            <h1 className="text-2xl font-bold tracking-wider">FLIPPER ZERO CO2 MONITOR</h1>
          </div>
          <div className="flex items-center gap-4">
            {isConnected ? (
              <div className="flex items-center gap-2">
                <Wifi className="w-5 h-5 text-green-700" />
                <span className="font-bold">CONNECTED</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <WifiOff className="w-5 h-5 text-red-700" />
                <span className="font-bold">DISCONNECTED</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-6">
        {/* Connection Controls */}
        <Card className="bg-gray-900 border-orange-500 mb-6">
          <CardHeader>
            <CardTitle className="text-orange-400 flex items-center gap-2">
              <Zap className="w-5 h-5" />
              Connection Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4">
              {!isConnected ? (
                <Button 
                  onClick={connectToFlipper}
                  disabled={isConnecting}
                  className="bg-orange-500 hover:bg-orange-600 text-black font-bold px-6 py-2 transition-all duration-200"
                >
                  {isConnecting ? 'CONNECTING...' : 'CONNECT TO FLIPPER ZERO'}
                </Button>
              ) : (
                <div className="flex gap-4">
                  <Button 
                    onClick={disconnect}
                    variant="outline"
                    className="border-red-500 text-red-400 hover:bg-red-500 hover:text-black"
                  >
                    DISCONNECT
                  </Button>
                  <Button 
                    onClick={readFlipperFile}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    READ CO2 DATA
                  </Button>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-400">
              Connect your Flipper Zero via USB to read CO2 logging data
            </p>
          </CardContent>
        </Card>

        {/* Chart Display */}
        {sessions.length > 0 && currentSession && (
          <Card className="bg-gray-900 border-orange-500">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-orange-400">
                  CO2 Logging Session {currentSessionIndex + 1} of {sessions.length}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={previousSession}
                    disabled={currentSessionIndex === 0}
                    variant="outline"
                    size="sm"
                    className="border-orange-500 text-orange-400 hover:bg-orange-500 hover:text-black disabled:opacity-30"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </Button>
                  <Button
                    onClick={nextSession}
                    disabled={currentSessionIndex === sessions.length - 1}
                    variant="outline"
                    size="sm"
                    className="border-orange-500 text-orange-400 hover:bg-orange-500 hover:text-black disabled:opacity-30"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div className="text-sm text-gray-400">
                <p>Start: {currentSession.startTime}</p>
                <p>End: {currentSession.endTime}</p>
                <p>Data Points: {currentSession.data.length}</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-96 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={currentSession.data}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis 
                      dataKey="formattedTime" 
                      stroke="#f97316"
                      fontSize={12}
                    />
                    <YAxis 
                      stroke="#f97316"
                      fontSize={12}
                    />
                    <Tooltip 
                      contentStyle={{
                        backgroundColor: '#1f2937',
                        border: '1px solid #f97316',
                        borderRadius: '4px',
                        color: '#f97316'
                      }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="co2_ppm" 
                      stroke="#f97316" 
                      strokeWidth={2}
                      dot={{ fill: '#f97316', strokeWidth: 2, r: 3 }}
                      activeDot={{ r: 5, fill: '#f97316' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Instructions */}
        {sessions.length === 0 && (
          <Card className="bg-gray-900 border-orange-500">
            <CardHeader>
              <CardTitle className="text-orange-400">Instructions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-gray-300">
                <p>1. Connect your Flipper Zero via USB</p>
                <p>2. Click "CONNECT TO FLIPPER ZERO" and grant permission</p>
                <p>3. The app will automatically read your CO2 logging data</p>
                <p>4. Use the arrow buttons to navigate between different logging sessions</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
};

export default Index;
